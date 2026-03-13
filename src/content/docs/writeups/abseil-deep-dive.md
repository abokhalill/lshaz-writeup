---
title: "We ran lshaz on Abseil. Here's what compile-time microarchitectural analysis actually finds in production C++."
description: "lshaz is a Clang/LLVM-based static analysis tool that detects microarchitectural latency hazards. That includes false sharing, atomic contention, cache line geometry problems. All at compile time, before code ships."
---

*lshaz is a Clang/LLVM-based static analysis tool that detects microarchitectural latency hazards. That includes false sharing, atomic contention, cache line geometry problems. All at compile time, before code ships.*

---

One thing you and I can agree on: no software system is perfect on all aspects. In our unfortunate case, we discuss performance. Whether it's a naive struct spanning multiple cache lines, false sharing, an overly strong memory ordering being expensive for no beneficial reason, an unfriendly NUMA topology, you name it. We've all seen it. Okay maybe not all but these are generally NOT what you want in a latency sensitive pipeline.

The tool presented, lshaz, is a static analyzer that maps code which compiles, looks correct, and even passes code review, to silent hardware failures. This blog delves particularly into the non-trivial findings on Abseil, a common C++ library by Google written by the most hardware-conscious engineers on the planet.

---

## The tool in action

Before we peek at what's under the Christmas tree, let's first take a step back and really understand what we're working with here. lshaz is a Clang/LLVM-based static analyzer that surfaces microarchitectural 'hazards' that standard compilers usually ignore.

The main entry point uses `ASTContext` to query `ASTRecordLayout`. Sadly, this is where the abstraction ends. From this point, one `RecursiveASTVisitor` walks the AST, basically taking a stroll through your code. Every time it encounters a struct, class, or union, it stops, which is `CXXRecordDecl`. This allows it to compute the individual byte offsets at every field inside your struct. There are 15 individual rules, each mapping with a unique hardware mechanism.

However, there's something you're probably wondering: what if most of these warnings are just complete false positives? What if the struct spanning multiple lines is a struct you access once a year anyways? What if a virtualized call gets devirtualized by the compiler? What about heap allocation that gets inlined? Essentially, how do we guarantee the tool is reliable at scale?

Enter the IR refinement. IR, or Intermediate Representation, is a strongly typed assembly-like programming language. You can think of it as a layer somewhat between the high-level source code and the low-level machine code. Its sole purpose is to verify whether that specific hazard flagged still exists after compiler optimization. If the same false sharing hazard still exists inside a hot loop after the IR pass, we got ourselves a 'proven' hazard. The confidence score is escalated and the hazard is now a verified finding worth auditing.

It's worth noting that this pass is optional with the `--no-ir` flag disabling it. Why disable it you might ask? Because it saves your precious time with the tragic sacrifice of only having your findings at 'likely' or 'speculative'.

There's obviously still a ton to be said about the tool's capabilities, design and architecture, but having everyone on the same page while being familiar with the tool's motivation is crucial before we uncover the Abseil findings.

---

## The Abseil Findings

At last, the fireworks. Or is it? Let's dive in.

Abseil is maintained by engineers who think about cache lines for a living. If lshaz was going to embarrass itself, this was the place. 157 translation units, zero failures, 352 diagnostics. 18 FL002 false sharing findings, 100% precision at the critical tier. No false positives on a codebase this well engineered. That's the headline. Now let's talk about what it actually found.

### HashtablezInfo 

The anchor finding is `HashtablezInfo` in `absl/container/internal/hashtablez_sampler.h`. This is the per-table sampling record for Abseil's SwissTable implementation, which is the hash map that runs inside essentially everything Google ships. When profiling is enabled, every sampled table gets a `HashtablezInfo` allocated from a global pool.

The struct contains 10 atomic fields packed across 3 cache lines, producing over 40 pairwise false sharing interactions.

Every hash table insert, erase, or rehash updates multiple of these atomics concurrently. When multiple threads operate on different sampled tables whose `HashtablezInfo` records land adjacently in the pool, the false sharing compounds. 

The fix is textbook field reordering: group the hot counters onto a dedicated `alignas(64)` line, probe stats onto another, hash stats onto a third. It's also worth noting here that while the memory cost is negligilbe, the contention cost isn't.

### ThreadIdentity 

Now this is fireworks. `ThreadIdentity` in `absl/base/internal/thread_identity.h` contains three atomics sharing cache lines 5 and 6: `ticker`, incremented on every mutex acquisition by the owning thread, and `wait_start` and `is_idle`, written by other threads during signaling.

When thread A signals thread B's semaphore, A writes to B's `ThreadIdentity`. If B is simultaneously updating its own ticker, the shared cache line ping-pongs between cores.

Here's the thing though. The Abseil authors knew. The cross-thread access pattern is documented explicitly in comments above the fields. This is not a bug anyone missed. It's a deliberate hardware trade-off made visible only if you compute the byte offsets manually.

So in a way, while it didn't exactly end in a 'gotcha', the Abseil author's comments validate that the tool pointed at something not so trivial at first glance. That's exactly what lshaz does. The struct is already 352 bytes, reordering ticker onto its own line costs zero additional memory. Well played.

### MutexGlobals

`MutexGlobals` in `absl/synchronization/mutex.cc` is a single 64-byte global with two atomics on the same cache line: `control_` and `spinloop_iterations`. Every `absl::Mutex::Lock` call reads `spinloop_iterations` to determine spin count. If anything writes `control_` during initialization, it invalidates every thread's cached spin count simultaneously.

One global, every mutex operation, one cache line. The fix is trivial padding. The exposure however, is not trivial.

## Conclusion

If we had to flatten everything onto one sentence, it's that we believe lshaz is a genuine tool which benefits developers, engineers and traders alike. At the time of this writing, the tool has already been benchmarked and tested against other industrial OSS such as Redis, PostgreSQL, and the entire LLVM monorepo, with significant findings across all 3 codebases. Those write-ups are coming.

The tool's full source code can be found at https://github.com/abokhalill/lshaz. Supports both C and C++. Try it on your own project and let us know!