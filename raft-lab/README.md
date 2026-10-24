# raft-lab: Understanding and Stress-Testing Raft

COMSM0122 Fundamentals of System Security, Workshop 4.
A simplified JavaScript Raft simulator, used to observe leader election, log replication, failure handling and operational hardening.

```bash
npm install
npm run election | heartbeats | leader-failure | replication | follower-failure
npm run majority-lost | partition | recovery | hardening
npm run hardening-extended   # Part 10 enhancements
```

---

## Part 1: Establishing Authority (`npm run election`)

| Observation | Result |
|---|---|
| Initial state | A, B, C all FOLLOWER, term 0 |
| Candidate | B |
| Votes | 3/3 (self + A + C); majority = 2 |
| Leader | B |
| Term | 1 |

**Explanation.** All three nodes start as followers in term 0 with no leader. Without a leader, nothing can be decided, so B begins an election. It increments its term to 1, votes for itself and sends RequestVote to A and C. Both grant their vote, giving B 3 of 3 votes, which exceeds the majority of 2, so B becomes leader for term 1. Leadership comes from a majority vote within a term, and only that leader may then coordinate client requests. A majority is used because any two majorities overlap in at least one node. Each node votes at most once per term, so two candidates cannot both collect a majority in the same term, and at most one leader can exist per term. Terms act as logical time: they order elections and let nodes reject messages from an older term.

**Reflection.** A leader must exist first so that one node decides the order of log entries. Otherwise concurrent proposers could conflict, as in Paxos. A majority is needed for the overlap property. One vote per term prevents simultaneous leaders. Terms order elections and expose stale leaders.

> Simulator note: `electLeader` counts a vote for every online peer it messages. It does not check the peer's term or `votedFor`, and it ignores whether the network delivered the message. Real Raft can refuse a vote.

## Part 2: Maintaining Leadership (`npm run heartbeats`)

- Two `AppendEntries(term=0, entries=[])` messages, one each to A and C.
- Both are heartbeats because `entries=[]`.
- Followers stay followers. No new election starts.

**Explanation.** A heartbeat is an AppendEntries message with no entries. When a follower receives one from a leader whose term is at least its own, it treats the leader as alive and resets its election timer. Because the timer keeps being reset, it never expires, so the follower never becomes a candidate. Raft uses one RPC for both heartbeats and replication. Any replication traffic therefore also proves the leader is alive, and the same consistency checks (term, prevLogIndex/prevLogTerm) apply to both. If heartbeats stopped, follower timers would expire, followers would become candidates in a new term, and a replacement leader would be elected.

> Simulator note: the heartbeats show `term=0` because the scenario calls `becomeLeader()` directly without an election. In real Raft a leader always has term ≥ 1.

## Part 3: Leader Failure and Re-Election (`npm run leader-failure`)

| Observation | Result |
|---|---|
| Failure | Leader B goes OFFLINE |
| Candidate | A |
| Votes | 2/3 (self + C); majority = 2 |
| New leader | A |
| New term | 1 |

**Explanation.** Leader B crashes, so A and C stop receiving heartbeats. A's election timer expires first. A becomes a candidate, moves to a new term and requests votes. Only C is reachable, and C grants its vote. Two of three votes is a majority, so A becomes leader. The cluster recovers without B because Raft needs a majority of nodes, not all of them. The new term separates A's authority from B's. If B comes back still believing it is leader, its first message carries the old term. Nodes in the newer term reject it, and B sees the higher term and steps down to follower. Only one leader stays effective because each term has at most one leader, and the newest term wins.

> Simulator note: the new term is 1 here, not 2, because B became leader in term 0 without an election.

## Part 4: Replicating History (`npm run replication`)

- Client request: `instances=10`, sent to leader B.
- Log entry: index 1, term 0, command `instances=10`.
- `AppendEntries(instances=10)` sent to A and C.
- Acknowledgements: 3 (B + A + C), against a majority of 2.
- `ENTRY COMMITTED` once acknowledgements reach the majority.

**Explanation.** The client sends the command to leader B, which appends it to its own log as a new entry tagged with its index and term. B sends the entry to the followers using AppendEntries. Each follower appends the entry and acknowledges it. Once a majority of nodes, the leader included, hold the entry, B marks it committed and can apply it and reply to the client. The entry is durable because any future leader must win votes from a majority, and that majority will include at least one node holding the entry. The election restriction makes sure a node with an incomplete log cannot win. What gets replicated is an ordered history (index + term + command), not a single value. Only the leader accepts writes so that there is one place deciding that order.

> Simulator note: entries are pushed to followers before the message is sent, and acknowledgements are counted even when the network drops the message.

## Part 5: Continuing Despite Failure (`npm run follower-failure`)

- C is offline.
- One AppendEntries message, to B only.
- Acknowledgements: 2 (A + B), majority 2 → **committed**.
- Part 4 sent two messages with 3 acks. Here one message and 2 acks are still enough.

**Explanation.** With C offline, leader A replicates the entry to B only. A and B together form 2 of 3 nodes, which is a majority, so the entry commits exactly as in Part 4. The only difference is less redundancy. C has nothing to do with progress. When it returns, the leader brings it up to date (Part 8). A three-node cluster tolerates ⌊(3−1)/2⌋ = 1 failure. In general, 2f+1 nodes tolerate f failures. Progress needs the leader plus enough followers to reach a majority, and no individual follower is essential. Quorums are used because they keep the overlap guarantee while tolerating minority failures, so the system is neither all-or-nothing nor at risk of split decisions.

## Part 6: When Progress Stops (`npm run majority-lost`)

- Online nodes: 2 (A, B), out of 5.
- Majority needed: 3.
- Leader election: **impossible**.
- New commits: **impossible**.

**Explanation.** Three of five nodes have failed, leaving 2 online, below the majority of 3. No candidate can collect 3 votes, so no leader can be elected. A leader that already exists cannot gather 3 acknowledgements, so nothing new commits. The requirement violated is that a majority be live and connected. Raft deliberately halts here. If two nodes could commit, the three failed nodes might, after recovering or being partitioned, form a different majority that has never seen those entries, producing divergent histories. Stopping protects safety, meaning consistency and no conflicting committed entries, at the cost of liveness, meaning availability. This is the C-over-A choice in CAP terms.

> Simulator note: A still shows role LEADER even without a majority. In real Raft it would keep that title but be unable to commit, and a well-behaved implementation would step down.

## Part 7: Surviving a Network Partition (`npm run partition`)

- Before: `AppendEntries(term=1)` **delivered**.
- During: `AppendEntries(term=1)` and `AppendEntries(instances=10)` both **dropped**.
- After repair: delivered again.

**Explanation.** A partition leaves every node running but splits the cluster into groups that cannot reach each other. Split-brain is the danger: each side elects a leader and accepts writes, producing two conflicting histories. Raft prevents this because a leader can only be elected with, and an entry can only commit on, a majority. Only one side of a partition can hold a majority, so only that side keeps evolving the log. A leader stranded on the minority side keeps running, but its AppendEntries never reach a majority, so its writes stay uncommitted. When the partition heals, it sees the higher term from the majority side, steps down, and its uncommitted entries are overwritten. Consistency is kept because availability on the minority side is sacrificed.

> Simulator note: the provided network drops **all** messages during a partition, so tasks 4–5 (which side holds the majority) cannot be observed. `partitionedNetwork.js` (Part 10) adds real groups: with `[A,B,C] | [D,E]`, A commits (3/5) and D cannot (2/5).

## Part 8: Repairing History (`npm run recovery`)

- Leader log: 5 entries (A–E). Follower log: 3 entries (A–C).
- Missing entries: indices 4 and 5.
- Recovery replays entries 4 and 5 from the leader.
- Final follower log length is 5, identical to the leader's.

**Explanation.** The follower has fallen behind and holds entries 1–3, while the leader holds 1–5. The leader sends the missing entries 4 and 5, and the follower appends them until both logs match. In real Raft, each AppendEntries carries prevLogIndex and prevLogTerm. If the follower's log does not match at that point, it rejects the message, the leader decrements nextIndex and retries, and when they meet at a matching point any conflicting follower entries are deleted and replaced. The follower trusts the leader because the election restriction ensures the leader holds every committed entry. Missing entries are replayed in order because state machines must apply the same commands in the same order to reach the same state. If conflicting histories remained, different nodes would apply different commands and replicas would diverge.

> Simulator note: recovery simply appends entries from `follower.log.length` onwards. It never compares terms, so it would not detect or repair conflicting entries.

## Part 9: Breaking Operational Assumptions (`npm run hardening`)

Output and meaning:

- `Unsafe election timeout`: a 50 ms timeout is below the 100 ms floor, so it is rejected.
- `WARNING: LEADERSHIP CHURN`: 10 elections exceed the threshold of 5.
- `Majority Available: true`: 3 of 5 online meets the majority of 3.
- Follower-lag monitoring is *listed* as a defence but not implemented. It is added in Part 10.

**Explanation.** These checks guard assumptions that the protocol relies on but does not enforce itself. First, timing: the election timeout must be much longer than the heartbeat interval and network delay, or followers time out while a healthy leader exists, causing election storms. Second, stable leadership: frequent leader changes (churn) mean repeated unavailability during elections and usually point to a timing, network or overload problem. Third, a live majority: 3/5 is technically healthy, but one more failure halts writes. Fourth, followers keeping up: a slow follower lowers real fault tolerance, because if it is counted towards the quorum and another node fails, commits stall. None of these break safety directly. They erode liveness and reliability, which is how most real Raft outages happen.

**Reflection.** Election storms come from timeouts that are too short or not randomised, from packet loss, or from GC/CPU pauses. Leadership churn means leadership changes repeatedly within a short window. Slow followers make the effective cluster smaller than it appears. The most critical assumptions are timeout tuning and keeping a live, connected majority.

---

## Part 10: Hardening a Raft Deployment (`npm run hardening-extended`)

New files: `monitor.js` (`ClusterMonitor`), `partitionedNetwork.js`, `scenarios/hardening_extended.js`.

| # | Enhancement | Weakness | Assumption protected | Implementation | Demonstrated | Limitations |
|---|---|---|---|---|---|---|
| 1 | Timeout validation | Timeout too short / not randomised | Heartbeat ≪ election timeout; randomisation avoids split votes | `validateTimeouts(hb, min, max)` requires min ≥ 3×heartbeat and a randomisation range | 100–100 ms rejected, 150–300 ms accepted | Static check; does not measure real network latency |
| 2 | Election storm detection | Repeated elections, no stable leader | Elections are rare | Sliding window over `recordElection` events | Warns at 4 elections in 10 ticks | Detects only; does not add PreVote |
| 3 | Leadership churn detection | Leader keeps changing | Leadership is stable | Counts leader changes in a window; also alerts on a leader claiming a term ≤ the previous leader's | 4 changes → warning; D claiming term 7 after term 10 → alert | Thresholds are arbitrary and need tuning |
| 4 | Quorum health reporting | "Majority available" hides how close failure is | A live majority exists | Reports online/needed, failures tolerated and remaining margin as OK / DEGRADED / CRITICAL | 5→4→3→2 nodes: OK, OK, DEGRADED, CRITICAL | Counts "online", not "reachable by the leader" |
| 5 | Follower lag monitoring | Slow followers shrink real fault tolerance | Followers keep up | Leader log length minus follower log length, flagged above a threshold | D lag 5, E lag 8 flagged | Uses length; real systems use matchIndex |
| 6 | Persistent state validation | Corrupted or misrestored disk state | Log indices contiguous, terms non-decreasing, currentTerm ≥ last log term | `validatePersistentState(node)` | Node X: index gap and term regression found | Cannot detect a valid-looking but wrong log |
| 7 | Partition monitoring | Original network is all-or-nothing | Only the majority side progresses | `PartitionedNetwork` with groups; `partitionReport` names the authoritative side | `[A,B,C]` commits 3/5; `[D,E]` cannot (2/5) | Symmetric partitions only |
| 8 | Audit logging | No trail for post-incident analysis | Events are attributable | Append-only, frozen, sequenced event records | Full trail printed at the end | In memory only; not tamper-proof (no hashing or signing) |

**Prevented vs detected.** Only timeout validation *prevents* a fault, by rejecting bad configuration before startup. Everything else *detects*: storms, churn, lag, partitions and corruption are reported for an operator or an automated response to act on.

**Complexity and new assumptions.** The monitor adds state and thresholds that must be tuned. Too sensitive causes alert fatigue, too lax misses real problems. It also assumes the monitor has an accurate view of the cluster, and a monitor that is itself partitioned may report incorrectly.

**Needed for production.** Real vote checks (term, `votedFor`, log up-to-date restriction), durable storage with fsync of term, vote and log, prevLogIndex/prevLogTerm consistency checks, PreVote and CheckQuorum (leaders step down without majority contact), log compaction and snapshots, safe membership changes (joint consensus), TLS between nodes, and metrics exported to real alerting. Raft also assumes crash faults, not Byzantine ones, so a malicious node would need BFT.

## Simulator simplifications found

1. Votes are always granted, with no term, `votedFor` or log check, and delivery is ignored.
2. Followers never update their term when they receive RequestVote or AppendEntries.
3. Scenarios call `becomeLeader()` directly, so leaders can have term 0.
4. Replication counts acknowledgements even for dropped messages.
5. Recovery appends without checking for conflicting entries.
6. Partitions are all-or-nothing (fixed in Part 10).
7. A leader without a majority keeps its LEADER role.
