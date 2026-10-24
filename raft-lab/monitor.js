// Part 10: operational hardening for the Raft simulator.
// Detects (does not prevent) violations of Raft's operational assumptions.
// Uses a logical clock ("tick") so the demo is deterministic.

class ClusterMonitor {

    constructor(cluster, options = {}) {
        this.cluster = cluster;
        this.electionWindow = options.electionWindow ?? 10;   // ticks
        this.maxElectionsInWindow = options.maxElectionsInWindow ?? 3;
        this.churnWindow = options.churnWindow ?? 20;          // ticks
        this.maxLeaderChanges = options.maxLeaderChanges ?? 3;
        this.maxFollowerLag = options.maxFollowerLag ?? 3;     // entries

        this.elections = [];      // { tick, nodeId, term }
        this.leaderHistory = [];  // { tick, nodeId, term }
        this.auditLog = [];       // append-only event trail
    }

    // ---------- Audit logging ----------
    audit(tick, event, details = {}) {
        const record = Object.freeze({ seq: this.auditLog.length + 1, tick, event, ...details });
        this.auditLog.push(record);
        return record;
    }

    printAudit() {
        console.log("\nAUDIT LOG");
        for (const r of this.auditLog) {
            const { seq, tick, event, ...rest } = r;
            console.log(`  #${seq} t=${tick} ${event} ${JSON.stringify(rest)}`);
        }
    }

    // ---------- Timeout validation ----------
    // Raft needs: heartbeat << election timeout, and a randomised range
    // so candidates don't time out together (split votes).
    static validateTimeouts(heartbeatMs, minTimeoutMs, maxTimeoutMs) {
        const problems = [];
        if (minTimeoutMs < 3 * heartbeatMs) {
            problems.push(`min election timeout (${minTimeoutMs}ms) < 3x heartbeat (${heartbeatMs}ms): followers may time out between heartbeats`);
        }
        if (maxTimeoutMs <= minTimeoutMs) {
            problems.push("no randomisation range: candidates will time out together (split votes)");
        } else if (maxTimeoutMs - minTimeoutMs < minTimeoutMs * 0.5) {
            problems.push("randomisation range is narrow: split votes more likely");
        }
        return { valid: problems.length === 0, problems };
    }

    // ---------- Election storm detection ----------
    recordElection(tick, nodeId, term) {
        this.elections.push({ tick, nodeId, term });
        this.audit(tick, "ELECTION_STARTED", { nodeId, term });
        return this.detectElectionStorm(tick);
    }

    detectElectionStorm(now) {
        const recent = this.elections.filter(e => now - e.tick < this.electionWindow);
        const storm = recent.length > this.maxElectionsInWindow;
        if (storm) {
            console.log(`WARNING: ELECTION STORM (${recent.length} elections in ${this.electionWindow} ticks)`);
            this.audit(now, "ELECTION_STORM", { count: recent.length });
        }
        return storm;
    }

    // ---------- Leadership churn detection ----------
    recordLeader(tick, nodeId, term) {
        const last = this.leaderHistory[this.leaderHistory.length - 1];
        if (last && term <= last.term) {
            // Two leaders claiming same/older term = safety alarm, not just churn.
            console.log(`ALERT: leader ${nodeId} claims term ${term} <= previous term ${last.term}`);
            this.audit(tick, "STALE_OR_DUPLICATE_LEADER", { nodeId, term, previousTerm: last.term });
        }
        this.leaderHistory.push({ tick, nodeId, term });
        this.audit(tick, "LEADER_ELECTED", { nodeId, term });
        return this.detectChurn(tick);
    }

    detectChurn(now) {
        const recent = this.leaderHistory.filter(l => now - l.tick < this.churnWindow);
        let changes = 0;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i].nodeId !== recent[i - 1].nodeId) changes++;
        }
        const churn = changes > this.maxLeaderChanges;
        if (churn) {
            console.log(`WARNING: LEADERSHIP CHURN (${changes} leader changes in ${this.churnWindow} ticks)`);
            this.audit(now, "LEADERSHIP_CHURN", { changes });
        }
        return churn;
    }

    // ---------- Quorum health ----------
    quorumHealth() {
        const total = this.cluster.nodes.length;
        const online = this.cluster.onlineNodes().length;
        const majority = this.cluster.majority();
        return {
            total,
            online,
            majority,
            healthy: online >= majority,
            faultsTolerated: total - majority,
            // How many more failures before progress stops (0 = one more failure halts writes)
            marginRemaining: Math.max(online - majority, -1)
        };
    }

    reportQuorum(tick) {
        const h = this.quorumHealth();
        let status = "OK";
        if (!h.healthy) status = "CRITICAL: NO QUORUM";
        else if (h.marginRemaining === 0) status = "DEGRADED: next failure halts progress";
        console.log(`Quorum: ${h.online}/${h.total} online, need ${h.majority} -> ${status}`);
        this.audit(tick, "QUORUM_CHECK", { online: h.online, majority: h.majority, status });
        return h;
    }

    // ---------- Follower lag ----------
    followerLag(tick) {
        const leader = this.cluster.leader();
        if (!leader) return [];
        const results = [];
        for (const peer of this.cluster.nodes) {
            if (peer === leader) continue;
            const lag = leader.log.length - peer.log.length;
            const lagging = lag > this.maxFollowerLag;
            results.push({ nodeId: peer.id, online: peer.online, lag, lagging });
            const flag = lagging ? "  <-- WARNING: LAGGING" : "";
            console.log(`  ${peer.id}: ${peer.log.length}/${leader.log.length} entries (lag ${lag})${flag}`);
            if (lagging) this.audit(tick, "FOLLOWER_LAG", { nodeId: peer.id, lag });
        }
        return results;
    }

    // ---------- Persistent state validation ----------
    // Invariants every node's durable state must satisfy.
    static validatePersistentState(node) {
        const errors = [];
        node.log.forEach((entry, i) => {
            if (entry.index !== i + 1) {
                errors.push(`index gap: position ${i + 1} holds index ${entry.index}`);
            }
            if (i > 0 && entry.term < node.log[i - 1].term) {
                errors.push(`term regression at index ${entry.index}: ${entry.term} < ${node.log[i - 1].term}`);
            }
        });
        const lastTerm = node.log.length ? node.log[node.log.length - 1].term : 0;
        if (node.currentTerm < lastTerm) {
            errors.push(`currentTerm ${node.currentTerm} < last log term ${lastTerm}`);
        }
        return { nodeId: node.id, valid: errors.length === 0, errors };
    }

    // ---------- Partition monitoring ----------
    partitionReport(tick, network) {
        const majority = this.cluster.majority();
        console.log(`Partition groups (majority = ${majority}):`);
        let authoritative = null;
        for (const group of network.groups) {
            const online = group.filter(id => this.cluster.nodes.find(n => n.id === id)?.online);
            const hasMajority = online.length >= majority;
            if (hasMajority) authoritative = group;
            console.log(`  [${group.join(", ")}] -> ${hasMajority ? "CAN make progress" : "CANNOT make progress"}`);
        }
        this.audit(tick, "PARTITION_CHECK", { groups: network.groups, authoritative });
        if (!authoritative) console.log("  WARNING: no partition holds a majority - cluster unavailable");
        return authoritative;
    }
}

module.exports = ClusterMonitor;
