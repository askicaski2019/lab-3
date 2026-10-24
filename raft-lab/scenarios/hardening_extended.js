// Part 10 demonstration: each enhancement shown in action.

const Node = require("../node");
const Cluster = require("../cluster");
const LogEntry = require("../logEntry");
const ClusterMonitor = require("../monitor");
const PartitionedNetwork = require("../partitionedNetwork");

const section = title => console.log(`\n==================== ${title} ====================`);

const nodes = ["A", "B", "C", "D", "E"].map(id => new Node(id));
const [a, b, c, d, e] = nodes;
const cluster = new Cluster(nodes);
const monitor = new ClusterMonitor(cluster);
let tick = 0;

// Silence node role-change logging during setup noise
const quiet = fn => { const log = console.log; console.log = () => {}; fn(); console.log = log; };

// 1. Timeout validation
section("1. ELECTION TIMEOUT VALIDATION");
for (const [hb, min, max] of [[50, 100, 100], [50, 150, 300]]) {
    const r = ClusterMonitor.validateTimeouts(hb, min, max);
    console.log(`heartbeat=${hb}ms timeout=${min}-${max}ms -> ${r.valid ? "VALID" : "INVALID"}`);
    r.problems.forEach(p => console.log(`  - ${p}`));
}

// 2. Election storm
section("2. ELECTION STORM DETECTION");
console.log("Nodes repeatedly time out (e.g. timeout too short / packet loss):");
for (const node of [a, b, c, a, d]) {
    quiet(() => node.becomeCandidate());
    tick += 2;
    console.log(`t=${tick} ${node.id} starts election for term ${node.currentTerm}`);
    monitor.recordElection(tick, node.id, node.currentTerm);
}

// 3. Leadership churn
section("3. LEADERSHIP CHURN DETECTION");
let term = 5;
for (const node of [a, b, a, c, b]) {
    tick += 3;
    term++;
    console.log(`t=${tick} ${node.id} becomes leader (term ${term})`);
    monitor.recordLeader(tick, node.id, term);
}
console.log("Buggy node claims leadership in an old term:");
monitor.recordLeader(++tick, "D", 7);

// 4. Quorum health
section("4. QUORUM HEALTH REPORTING");
quiet(() => nodes.forEach(n => n.becomeFollower(term)));
quiet(() => a.becomeLeader());
monitor.reportQuorum(++tick);
for (const node of [e, d, c]) {
    quiet(() => node.fail());
    console.log(`${node.id} fails`);
    monitor.reportQuorum(++tick);
}
quiet(() => [c, d, e].forEach(n => n.recover()));

// 5. Follower lag
section("5. FOLLOWER LAG MONITORING");
for (let i = 1; i <= 10; i++) a.log.push(new LogEntry(i, term, `cmd${i}`));
b.log = a.log.slice(0, 10);
c.log = a.log.slice(0, 9);
d.log = a.log.slice(0, 5);
e.log = a.log.slice(0, 2);
monitor.followerLag(++tick);

// 6. Persistent state validation
section("6. PERSISTENT STATE VALIDATION");
const corrupt = new Node("X");
corrupt.currentTerm = 2;
corrupt.log = [new LogEntry(1, 1, "a"), new LogEntry(3, 3, "b"), new LogEntry(4, 2, "c")];
for (const node of [a, corrupt]) {
    const r = ClusterMonitor.validatePersistentState(node);
    console.log(`${node.id}: ${r.valid ? "VALID" : "INVALID"}`);
    r.errors.forEach(err => console.log(`  - ${err}`));
    if (!r.valid) monitor.audit(tick, "STATE_INVALID", { nodeId: node.id, errors: r.errors.length });
}

// 7. Partition monitoring
section("7. PARTITION MONITORING");
const net = new PartitionedNetwork(nodes.map(n => n.id));
net.split(["A", "B", "C"], ["D", "E"]);
monitor.partitionReport(++tick, net);
for (const leaderId of ["A", "D"]) {
    let acks = 1;
    for (const peer of nodes) {
        if (peer.id !== leaderId && net.sendTo(leaderId, peer.id, "AppendEntries(x=1)")) acks++;
    }
    const ok = acks >= cluster.majority();
    console.log(`${leaderId} acks=${acks}/${nodes.length} -> ${ok ? "COMMITTED" : "NOT COMMITTED"}`);
}
net.repair();

monitor.printAudit();
