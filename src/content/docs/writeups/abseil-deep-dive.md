---
title: "We ran lshaz on Abseil. Here's what compile-time microarchitectural analysis actually finds in production C++."
description: "lshaz is a Clang/LLVM-based static analysis tool that detects microarchitectural latency hazards. That includes false sharing, atomic contention, cache line geometry problems. All at compile time, before code ships."
---

*lshaz is a Clang/LLVM-based static analysis tool that detects microarchitectural latency hazards. That includes false sharing, atomic contention, cache line geometry problems. All at compile time, before code ships.*

---

Let me tell you something that most people writing C++ don't want to admit.

The performance problem you'll spend three days hunting next quarter? It's already in your codebase right now. It's sitting there quietly in a struct definition, in a field ordering that made total sense when someone wrote it, in an atomic variable placed four bytes away from the field that every other thread also writes. The source code looks fine. The tests pass. The code review was clean. And the hardware is silently paying a tax on every cache coherence round-trip that nobody asked for and nobody knows about.

You won't find it until production load puts enough concurrent threads on it that `perf c2c` finally lights up. By then it's been shipping for six months.

This is the problem lshaz exists to solve. It's a Clang LibTooling analysis pass that reasons about the same things the CPU reasons about — byte offsets, cache line boundaries, memory ordering semantics, MESI coherence protocol costs — and it does it at compile time, from source, before any of that ends up in production.

To find out if it actually works, we pointed it at Abseil. Google's C++ common libraries. Code maintained by engineers who think about performance for a living, on a codebase that runs inside essentially everything Google ships. If lshaz was going to embarrass itself, this was the place.

256 diagnostics. Here's what they mean.

---

## The Finding That Stopped Us

The highest-confidence result — flagged by three independent rules simultaneously, 88–90% confidence at the Proven evidence tier, confirmed across 36 translation units — was a struct called `ThreadIdentity`.

You've probably never heard of it. It lives in `absl/base/internal/thread_identity.h` and it's the per-thread state object that Abseil's synchronization infrastructure hangs everything on. Every active thread has one. The Mutex implementation knows about it. The CondVar implementation knows about it. It's load-bearing in a very quiet way.

Here's the relevant part of the layout:

```cpp
struct ThreadIdentity {
  PerThreadSynch per_thread_synch;     // offset 0,   size 64B
  
  struct WaiterState {
    alignas(void*) char data[256];
  } waiter_state;                      // offset 64,  size 256B

  std::atomic<int>* blocked_count_ptr; // offset 320, size 8B

  // "read by a ticker thread as a hint"
  std::atomic<int>  ticker;            // offset 328
  std::atomic<int>  wait_start;        // offset 332
  std::atomic<bool> is_idle;           // offset 336
  
  ThreadIdentity* next;                // offset 340
};
```

Now here's the part that matters. On x86-64, cache lines are 64 bytes. Offset 320 begins cache line 5. `blocked_count_ptr` occupies bytes 320–327. Then `ticker` at 328, `wait_start` at 332, `is_idle` at 336. All three atomic fields, written by different threads, are packed onto the same 64-byte line.

lshaz saw it immediately:

```
[Critical] FL002 — False Sharing  conf=88%  [proven]
Struct 'ThreadIdentity' (352B, 6 lines): atomic fields 'ticker' and 'wait_start'
share line 5: guaranteed cross-core invalidation on write.
atomic fields 'ticker' and 'is_idle' share line 5.
atomic fields 'wait_start' and 'is_idle' share line 5.
line 5: 3 atomic + 2 non-atomic mutable fields — mixed write surface.
cross-TU: deduplicated from 36 translation units.
```

Every time the ticker thread writes `ticker`, the hardware has to acquire exclusive ownership of that cache line. Which means every other core that holds a copy of that line, including the thread that owns the identity and is actively reading `wait_start`, has to invalidate its copy and wait for the line to come back. That's the MESI coherence protocol doing exactly what it was designed to do, and it costs you every single time.

---

## Before You Write the Bug Report

Stop. This is not a bug.

The Abseil source is explicit about it. Right above those three atomics:

*"The following variables are mostly read/written just by the thread itself. The only exception is that these are read by a ticker thread as a hint."*

The Abseil authors knew. They looked at this layout, computed the byte offsets, the same ones lshaz computed, and decided the coherence traffic was an acceptable cost. The ticker thread reads these fields as hints. It doesn't need them isolated. The design is intentional.

And if you had any doubt, there's this, elsewhere in the same file:

*"NOTE: The layout of fields in this structure is critical, please do not add, remove, or modify the field placements without fully auditing the layout."*

These are engineers telling you they did the work. They understood what the hardware would do and made a conscious call.

Here's what lshaz actually found: **a deliberate hardware trade-off that is completely invisible to anyone who didn't do that work themselves.** If you're reading `ThreadIdentity` in a fork, or inheriting a system built on it, or trying to understand why your synchronization-heavy code has unexpected coherence traffic, there is nothing in the source that tells you cache line 5 is a known hot zone. No `alignas`, no comment on the field declarations, no `// COHERENCE_COST_ACCEPTED`. The knowledge lives in the heads of the people who wrote it.

That's the gap. lshaz closes it.

---

## Why This One Finding Is Actually Four

`ThreadIdentity` doesn't just trigger FL002. It hits FL001 and FL090 simultaneously, and the combination matters.

FL001 caught that the struct spans 352 bytes across 6 cache lines, with 2 fields straddling line boundaries, meaning every access to those fields is a split load or split store, touching two cache lines instead of one.

FL090 is the compound hazard rule, and it fires when multiple hazard types converge on the same type. Here they all arrive at once: cache spanning, false sharing, straddling fields, wide write surface, confirmed thread escape. When these stack, the hardware cost isn't additive, it multiplies. A field that straddles a cache line boundary on a struct that also has active coherence contention pays the split-load penalty *and* the RFO round-trip *on the same access*. The compound rule exists specifically because single-rule analysis misses this.

The 36 TU deduplication count is what makes the Proven tier confidence legitimate. The tool saw this struct diagnosed from 36 independent translation unit compilation contexts. That's not a tool artifact, that's real evidence that this type is genuinely ubiquitous across the codebase.

---

## The Second Finding: When Atomic Density Is the Problem

The other finding worth looking at is `HashtablezInfo` in `absl/container/internal/hashtablez_sampler.h`, which is Abseil's internal hash table telemetry struct.

```
[Critical] FL002  conf=88%  [proven]
'HashtablezInfo' (664B, 11 lines): 20 atomic pairs share cache lines.
Line 0: mu_, capacity, size, num_erases, num_rehashes — 5 atomics co-located.
Line 1: max_probe_length, total_probe_length, hashes_bitwise_or,
        hashes_bitwise_and, max_reserve — 5 more atomics co-located.
cross-TU: deduplicated from 7 translation units.
```

Ten atomic fields, two cache lines, twenty pairs that each generate guaranteed MESI invalidations. This is a sampling struct, it's not on the critical path by design, and the false sharing is almost certainly an intentional cost. But it illustrates a different failure mode: not "we put two fields near each other that happen to share a line," but "we have so many atomics in this struct that false sharing is geometrically inevitable regardless of ordering."

At 5 atomics per line, every write to any field invalidates the line for every thread reading any of the other four. That's the design you get when you reach for atomics without also reaching for `alignas`.

---

## What 256 Actually Means

Not 256 bugs. If you walk away with that impression, the tool failed to communicate.

The **Proven tier** findings, where lshaz has structural evidence confirmed across multiple TUs, are the ones above. The hardware reasoning is unambiguous: given the struct layout, given the cache line geometry, given confirmed thread escape, this is what the CPU does. Whether that cost matters depends entirely on whether that path is hot in your workload.

The **Likely** findings are one evidence dimension short. The struct has atomics, the layout creates contention surface, but cross-TU multiplicity didn't confirm broad usage. These are hypotheses. Treat them as such.

The **Speculative** findings are signals, not conclusions. Something in the source suggests a hazard but the confidence doesn't justify flagging it as a finding in any meaningful sense. They're there because suppressing them entirely means silent false negatives, and false negatives are worse than noisy output.

The architecture-specific behavior is worth mentioning: on x86-64's TSO memory model, `seq_cst` loads are free, just a plain old MOV instruction. lshaz knows this. It only flags `seq_cst` stores and RMW operations where the `LOCK` prefix is real. On ARM64, the analysis changes completely - every `seq_cst` operation carries a full `DMB ISH` barrier. The same source file produces different diagnostics on different target architectures, because the hardware costs are genuinely different.

---

## The Thing No Other Analyzer Does

clang-tidy, Coverity, PVS-Studio — they'll tell you about use-after-free, uninitialized memory, null dereferences. None of them will tell you that your struct's field ordering is costing you 200 cycles per operation under contention. That's not their domain. Their domain is correctness. lshaz's domain is the gap between correct code and code that respects what the hardware actually does.

And unlike every other static analyzer, lshaz doesn't just report a finding and move on. For every diagnostic, it constructs a formal hypothesis, with null and alternative, the specific PMU counters needed to test it (`MEM_INST_RETIRED.LOCK_LOADS`, `L2_RQSTS.ALL_RFO`, `OFFCORE_REQUESTS.ALL_DATA_RD`), the statistical parameters (α=0.01, power=0.90), and a complete experiment bundle you can run with `perf stat` or `perf c2c` to find out if the tool is right.

That last part is not a feature. It's an acknowledgment of a hard truth: static analysis produces false positives. The correct response to that isn't to tune the tool until the false positive rate is acceptable. It's to build the tool so it can tell you how to find out if it's wrong.

---

## Where To Find It

lshaz is at [github.com/abokhalill/lshaz](https://github.com/abokhalill/lshaz).

Clang 18, compile_commands.json required. Point it at your codebase:

```bash
lshaz scan --target-arch x86-64 /path/to/your/project
```

`lshaz diff` exits 1 on new findings; drop it in CI and it becomes a gate. SARIF output goes directly to GitHub Code Scanning.

If you find cases where the hardware reasoning is wrong, that's the most valuable feedback the tool can receive. The calibration system exists precisely for that.