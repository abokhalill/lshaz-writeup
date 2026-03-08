---
title: "We ran lshaz on Abseil. Here's what compile-time microarchitectural analysis actually finds in production C++."
description: "lshaz is a Clang/LLVM-based static analysis tool that detects microarchitectural latency hazards — false sharing, atomic contention, cache line geometry problems — at compile time, before code ships."
---

*lshaz is a Clang/LLVM-based static analysis tool that detects microarchitectural latency hazards — false sharing, atomic contention, cache line geometry problems — at compile time, before code ships.*

---

The standard feedback loop for microarchitectural performance problems in C++ looks like this: write code, ship it, run `perf c2c` or `perf stat` in production, discover that two fields on the same struct are destroying your L1 cache hit rate across cores, fix it, repeat. The loop is reactive. The diagnosis happens after the damage is in production.

lshaz is an attempt to move that loop earlier — to the point where a struct layout is being written, not the point where it's being profiled. It's a Clang LibTooling analysis pass that reasons about struct field geometry, atomic ordering choices, thread escape, and NUMA placement using the same information the CPU will use at runtime: byte offsets, cache line boundaries, memory ordering semantics, and hardware coherence protocol costs.

To test whether the tool produces signal worth acting on, we ran it against the Abseil-C++ codebase — Google's widely-used C++ common libraries, maintained by engineers who are not casual about performance. The result was 256 diagnostics across the codebase. This post is about what those findings actually mean.

---

## The Anchor Finding: `ThreadIdentity`

The highest-signal finding lshaz produced — flagged simultaneously by three separate rules with 88–90% confidence at the Proven evidence tier, and deduplicated across 36 translation units — is `absl::base_internal::ThreadIdentity`.

Here is the relevant portion of the struct layout (from `absl/base/internal/thread_identity.h`):

```cpp
struct ThreadIdentity {
  // Must be the first member. PerThreadSynch::kAlignment aligned.
  PerThreadSynch per_thread_synch;   // offset 0,   size 64B

  struct WaiterState {
    alignas(void*) char data[256];
  } waiter_state;                    // offset 64,  size 256B

  std::atomic<int>* blocked_count_ptr; // offset 320, size 8B

  // "read by a ticker thread as a hint"
  std::atomic<int>  ticker;          // offset 328
  std::atomic<int>  wait_start;      // offset 332
  std::atomic<bool> is_idle;         // offset 336
  
  ThreadIdentity* next;              // offset 340
};
```

At 64-byte cache line boundaries on x86-64, offset 320 begins line 5 (zero-indexed). `blocked_count_ptr` sits at 320–327. `ticker`, `wait_start`, and `is_idle` land at 328, 332, and 336 — all on line 5. Three independent atomic fields, written by different threads, sharing one cache line.

lshaz's diagnosis:

```
[Critical] FL002 — False Sharing  conf=88%  [proven]
Struct 'ThreadIdentity' (352B, 6 lines): atomic fields 'ticker' and 'wait_start'
share line 5: guaranteed cross-core invalidation on write.
atomic fields 'ticker' and 'is_idle' share line 5.
atomic fields 'wait_start' and 'is_idle' share line 5.
line 5: 3 atomic + 2 non-atomic mutable fields — mixed write surface.
cross-TU: deduplicated from 36 translation units.

[Critical] FL090 — Compound Hazard Amplification  conf=88%
352B across 6 cache lines. 4 atomic fields across 2 lines.
2 fields straddle line boundaries: split load/store penalty compounds
with coherence cost. 21 mutable fields across 6 lines: wide write surface.
```

**This is not a bug.** The Abseil source includes this comment directly above the three atomics: *"The following variables are mostly read/written just by the thread itself. The only exception is that these are read by a ticker thread as a hint."*

The Abseil authors knew. They made a deliberate trade-off: the ticker thread reads these fields as hints — it doesn't need them to be isolated. The coherence traffic is accepted as a cost of the design. The struct layout note elsewhere in the file is emphatic: *"NOTE: The layout of fields in this structure is critical, please do not add, remove, or modify the field placements without fully auditing the layout."*

What lshaz found here is not an oversight. It is a **deliberate hardware trade-off that is invisible to any reader of the source** unless they mentally compute byte offsets, know the cache line width, and reason about the MESI coherence protocol. The Abseil authors did that work. But anyone reading this struct in a downstream codebase, or inheriting it in a fork, has no indication from the source that line 5 is a coherence hot zone.

This is precisely the class of problem lshaz is designed to surface.

---

## What Makes This Structurally Interesting: The Compound Hazard

`ThreadIdentity` triggers lshaz's FL090 (Compound Hazard Amplification) rule because multiple independent hazard indicators converge on the same type:

- **Cache spanning**: 352B across 6 lines, with 2 fields straddling boundaries (split load/store on every access)
- **False sharing**: 3 atomic pairs confirmed on line 5
- **Wide write surface**: 21 mutable fields across 6 lines
- **Thread escape**: confirmed via 36 TU inclusions and structural atomic evidence

When these co-occur, the hardware cost is not additive — it's multiplicative. A split load across a line boundary on a field that is also a coherence contention point means every access pays both the split-load penalty and the RFO (Read For Ownership) round-trip to acquire the line. The compound rule exists specifically to identify this amplification, which single-rule analysis misses.

---

## The Second Finding Worth Examining: `HashtablezInfo`

The second-highest confidence finding is `absl::container::internal::HashtablezInfo` in `absl/container/internal/hashtablez_sampler.h`. This is a sampling/telemetry struct — it collects statistics about hash table behavior for Abseil's internal profiling infrastructure.

```
[Critical] FL002  conf=88%  [proven]
'HashtablezInfo' (664B, 11 lines): 20 atomic pairs share cache lines.
Line 0: mu_, capacity, size, num_erases, num_rehashes — 5 atomics co-located.
Line 1: max_probe_length, total_probe_length, hashes_bitwise_or,
        hashes_bitwise_and, max_reserve — 5 more atomics co-located.
cross-TU: deduplicated from 7 translation units.
```

10 atomic fields concentrated across 2 cache lines, 20 atomic pairs generating MESI invalidations. This is a sampling struct, so the false sharing is likely an intentional cost — sampling infrastructure is not expected to be in the critical path. But it is a concrete example of what the tool finds when atomic density is high and layout is not explicitly managed.

---

## The 256 Number in Context

The full scan produced 256 diagnostics. The distribution matters:

The **Proven tier** findings — where lshaz has both structural evidence (field layout, atomic types, escape analysis) and cross-TU confirmation — are the ones shown above. The Critical/Proven findings represent cases where the hardware reasoning is unambiguous given the struct layout.

The **Likely** and **Speculative** tier findings represent cases where one evidence dimension is missing: the struct escapes to threads per structural analysis but isn't confirmed via cross-TU multiplicity, or the field co-location is present but the access pattern isn't confirmed hot. These are hypotheses, not verdicts.

The FL010 findings (overly strong atomic ordering) are architecture-aware: on x86-64's TSO memory model, `seq_cst` loads are free (plain MOV), so lshaz only flags stores and RMW operations where the XCHG/LOCK prefix cost is real. On ARM64, the analysis changes — every `seq_cst` operation carries a full `DMB ISH` barrier cost. The same source file can produce different diagnostics on different target architectures, which is the correct behavior.

None of this means Abseil has 256 performance problems. It means lshaz found 256 locations where hardware cost is latent in the source, ranging from confirmed coherence contention to speculative ordering inefficiencies. What you do with that signal depends on whether those paths are hot in your workload.

---

## The Part No Other Static Analyzer Does

Every analyzer from clang-tidy to Coverity can tell you about use-after-free, uninitialized reads, and null dereferences. None of them generate statistically rigorous PMU experiments to validate their predictions.

For every diagnostic lshaz emits, it constructs a formal hypothesis: a null and alternative hypothesis, the specific hardware performance counters required to test it (`MEM_INST_RETIRED.LOCK_LOADS`, `L2_RQSTS.ALL_RFO`, `OFFCORE_REQUESTS.ALL_DATA_RD`), the statistical parameters ($\alpha=0.01$, power $=0.90$), and a complete experiment bundle — harness, Makefile, collection scripts — that an engineer can run to confirm or refute the prediction. Results feed back into a Bayesian confidence model that adjusts future predictions.

The hypothesis engine exists because the fundamental limitation of static analysis is false positives. The correct response to that limitation is not to suppress warnings until the false positive rate is acceptable. It is to make the tool tell you how to find out if it's right.

---

## Where To Find It

lshaz is available at [github.com/abokhalill/lshaz](https://github.com/abokhalill/lshaz).

It builds against LLVM/Clang 18. A `compile_commands.json` is required. Running against your own codebase:

```bash
lshaz scan --target-arch x86-64 /path/to/your/project
```

The `lshaz diff` subcommand produces exit code 1 on new findings, which makes it a drop-in CI gate. SARIF output integrates directly with GitHub Code Scanning.

Feedback, corrections, and counterexamples are welcome — especially cases where the hardware reasoning is wrong. The calibration system gets better with data.
