// Part 10: a network that splits nodes into groups, rather than the
// original all-or-nothing partition. Messages only cross within a group.

const Network = require("./network");

class PartitionedNetwork extends Network {

    constructor(nodeIds) {
        super();
        this.groups = [nodeIds.slice()];
    }

    split(...groups) {
        this.groups = groups;
        this.partitioned = groups.length > 1;
        console.log(`NETWORK PARTITION: ${groups.map(g => `[${g.join(",")}]`).join(" | ")}`);
    }

    repair() {
        this.groups = [this.groups.flat()];
        this.partitioned = false;
        console.log("NETWORK PARTITION REPAIRED");
    }

    canReach(from, to) {
        return this.groups.some(g => g.includes(from) && g.includes(to));
    }

    sendTo(from, to, message) {
        if (!this.canReach(from, to)) {
            console.log(`NETWORK DROPPED: ${from} -> ${to} ${message}`);
            return false;
        }
        console.log(`NETWORK DELIVERED: ${from} -> ${to} ${message}`);
        return true;
    }
}

module.exports = PartitionedNetwork;
