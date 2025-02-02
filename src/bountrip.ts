// bountrip.ts
import {
    NearBindgen,
    near,
    call,
    view,
    assert,
    UnorderedMap,
} from 'near-sdk-js';

/**
 * Represents a single Bounty.
 */
interface Bounty {
    id: number;
    creator: string;
    totalPrize: string;  // store as string for BigInt compatibility
    prizes: string[];    // each prize stored as string
    participants: string[];
    winners: string[];
    isActive: boolean;
}

@NearBindgen({})
class Bountrip {
    /** A persistent map of bountyId -> Bounty */
        // @ts-ignore
    bounties: UnorderedMap<string, Bounty>;

    /** Number of bounties created so far */
    bountyCount: number;

    /**
     * Contract owner (receives fees).
     * We do *not* call `near.predecessorAccountId()` in constructor, to avoid ProhibitedInView error.
     */
    owner: string;

    /**
     * Fee percentage to deduct from each prize (0-100).
     */
    feePercentage: number;

    /**
     * The constructor only initializes data structures and default fee (2).
     * We do not set `owner` here with `predecessorAccountId()`
     * because that might cause re-invocations in view context.
     */
    constructor() {
        // @ts-ignore
        this.bounties = new UnorderedMap<string, Bounty>('bounties');
        this.bountyCount = 0;

        this.owner = '';        // no owner yet
        this.feePercentage = 2; // default: 2%

        near.log('Contract constructed: bounties map ready, fee=2, no owner set yet.');
    }

    /**
     * Sets or changes the owner. If there's no owner yet, the first caller becomes owner.
     * Otherwise, only the current owner can change it to a new owner.
     * @param new_owner The accountId to become the new owner
     */
    @call({})
    set_owner({new_owner}: { new_owner?: string }): void {
        // The caller is always near.predecessorAccountId()
        const caller = near.predecessorAccountId();

        if (!this.owner) {
            // If no owner was ever set, the first caller is the owner.
            this.owner = caller;
            near.log(`Owner is now: ${this.owner} (first-time set)`);
        } else {
            // If we already have an owner, only that owner can change it
            assert(caller === this.owner, `Only current owner (${this.owner}) can change ownership.`);
            // If no new_owner is given, we can keep the same (no real usage).
            if (new_owner && new_owner.trim().length > 0) {
                this.owner = new_owner;
                near.log(`Owner changed to: ${this.owner}`);
            } else {
                near.log(`Owner remains: ${this.owner} (no new_owner provided)`);
            }
        }
    }

    /**
     * Update the fee percentage (0 to 100). Only the owner can do this.
     */
    @call({})
    update_fee_percentage({feePercentage}: { feePercentage: number }): void {
        assert(this.owner !== '', 'Owner not set yet. Call set_owner first.');
        assert(
            near.predecessorAccountId() === this.owner,
            `Only the owner (${this.owner}) can update the fee.`
        );
        assert(feePercentage >= 0 && feePercentage <= 100, 'fee must be 0..100');
        this.feePercentage = feePercentage;
        near.log(`Fee updated to ${feePercentage}% by ${this.owner}`);
    }

    /**
     * Create a new bounty. The attached deposit must match the sum of the given `prizes`.
     */
    @call({payableFunction: true})
    create_bounty({prizes}: { prizes: string[] }): { bountyId: number } {
        const creator = near.predecessorAccountId();
        const deposit = near.attachedDeposit();

        assert(Array.isArray(prizes) && prizes.length > 0, 'Prizes must be a non-empty array.');

        let total = BigInt(0);
        for (let p of prizes) {
            total += BigInt(p);
        }
        assert(deposit === total, 'Attached deposit must match total of all prizes.');

        const bounty: Bounty = {
            id: this.bountyCount,
            creator,
            totalPrize: total.toString(),
            prizes: prizes.map((p) => BigInt(p).toString()),
            participants: [],
            winners: [],
            isActive: true,
        };

        this.bounties.set(this.bountyCount.toString(), bounty);
        near.log(`Bounty ${bounty.id} created by ${creator}, totalPrize = ${bounty.totalPrize}`);

        this.bountyCount += 1;
        return {bountyId: bounty.id};
    }

    /**
     * Participate in an active bounty. This is payable, but typically 0 deposit is needed.
     */
    @call({payableFunction: true})
    participate({bountyId}: { bountyId: number }): void {
        const participant = near.predecessorAccountId();
        const bounty = this.bounties.get(bountyId.toString());
        assert(bounty, 'Bounty does not exist.');
        assert(bounty.isActive, 'Bounty is already finalized or inactive.');

        if (!bounty.participants.includes(participant)) {
            bounty.participants.push(participant);
            this.bounties.set(bountyId.toString(), bounty);
            near.log(`Participant ${participant} joined bounty ${bountyId}`);
        } else {
            near.log(`Participant ${participant} was already in bounty ${bountyId}`);
        }
    }

    /**
     * Finalize the bounty with an array of winners. The # of winners must match # of prizes.
     * The bounty's creator is the only one allowed to call this.
     */
    @call({payableFunction: true})
    finalize_bounty({bountyId, winners}: { bountyId: number; winners: string[] }): void {
        const caller = near.predecessorAccountId();
        const bounty = this.bounties.get(bountyId.toString());
        assert(bounty, 'Bounty does not exist.');
        assert(bounty.isActive, 'Bounty is already finalized.');
        assert(caller === bounty.creator, 'Only the bounty creator can finalize this bounty.');

        assert(Array.isArray(winners) && winners.length > 0, 'Must provide at least one winner.');
        assert(
            winners.length === bounty.prizes.length,
            'Number of winners must match the number of prizes.'
        );

        // Check that each winner is in participants
        for (let w of winners) {
            assert(bounty.participants.includes(w), `Winner ${w} is not a participant of this bounty.`);
        }

        bounty.winners = winners;
        bounty.isActive = false;
        this.bounties.set(bountyId.toString(), bounty);

        near.log(`Bounty ${bountyId} finalized by ${caller}. Winners: ${winners.join(', ')}`);

        // Distribute prizes with fees
        this._distribute_prizes(bounty);
    }

    /**
     * Internal method to distribute each prize to its winner, deducting the fee and sending that to `owner`.
     */
    private _distribute_prizes(bounty: Bounty): void {
        // If owner isn't set yet, we skip fees (or we could just fail).
        if (!this.owner) {
            near.log('No owner set, skipping fee logic. All prizes go to winners.');
        }

        let totalFee = BigInt(0);

        for (let i = 0; i < bounty.winners.length; i++) {
            const winner = bounty.winners[i];
            const prizeAmount = BigInt(bounty.prizes[i]);

            // if no owner is set, fee=0
            let fee = BigInt(0);
            if (this.owner) {
                fee = (prizeAmount * BigInt(this.feePercentage)) / BigInt(100);
            }
            const netPrize = prizeAmount - fee;
            totalFee += fee;

            // Transfer net prize
            const promise = near.promiseBatchCreate(winner);
            near.promiseBatchActionTransfer(promise, netPrize);

            near.log(
                `Transferred net prize ${netPrize} to winner ${winner}, fee deducted = ${fee}`
            );
        }

        // Transfer fee to the owner
        if (totalFee > BigInt(0)) {
            const feePromise = near.promiseBatchCreate(this.owner);
            near.promiseBatchActionTransfer(feePromise, totalFee);
            near.log(`Transferred total fee ${totalFee} to contract owner ${this.owner}`);
        }
    }

    /**
     * View method: get current owner and fee
     */
    @view({})
    get_fee_info(): { owner: string; feePercentage: number } {
        return {
            owner: this.owner,
            feePercentage: this.feePercentage,
        };
    }

    /**
     * View method: get a bounty by its ID
     */
    @view({})
    get_bounty({bountyId}: { bountyId: number }): Bounty {
        const bounty = this.bounties.get(bountyId.toString());
        assert(bounty, 'Bounty does not exist.');
        return bounty;
    }

    /**
     * View method: get all bounties
     */
    @view({})
    get_all_bounties(): Bounty[] {
        const all: Bounty[] = [];
        for (let i = 0; i < this.bountyCount; i++) {
            const b = this.bounties.get(i.toString());
            if (b) all.push(b);
        }
        return all;
    }

    /**
     * View method: get bounties where participantId is a participant
     */
    @view({})
    get_participant_bounties({participantId}: { participantId: string }): Bounty[] {
        const result: Bounty[] = [];
        for (let i = 0; i < this.bountyCount; i++) {
            const b = this.bounties.get(i.toString());
            if (b && b.participants.includes(participantId)) {
                result.push(b);
            }
        }
        return result;
    }

    /**
     * View method: get bounties where creatorId is the creator
     */
    @view({})
    get_creator_bounties({creatorId}: { creatorId: string }): Bounty[] {
        const result: Bounty[] = [];
        for (let i = 0; i < this.bountyCount; i++) {
            const b = this.bounties.get(i.toString());
            if (b && b.creator === creatorId) {
                result.push(b);
            }
        }
        return result;
    }
}
