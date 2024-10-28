// Importar dependencias desde NEAR SDK
import {
    NearBindgen,
    near,
    call,
    view,
    assert,
    UnorderedMap,
} from 'near-sdk-js';

// Definir la interfaz Bounty
interface Bounty {
    id: number;
    creator: string;
    totalPrize: string; // Almacenar como string para compatibilidad con BigInt
    prizes: string[]; // Array de strings para compatibilidad con BigInt
    participants: string[];
    winners: string[];
    isActive: boolean;
}

@NearBindgen({})
class Bountrip {
    // Colecciones persistentes y variables de estado
    // @ts-ignore
    bounties: UnorderedMap<string, Bounty>;
    bountyCount: number;

    // Constructor que inicializa UnorderedMap y bountyCount
    constructor() {
        // Inicializar el mapa de bounties con un prefijo único
        // @ts-ignore
        this.bounties = new UnorderedMap<string, Bounty>('bounties');
        this.bountyCount = 0;
        near.log("Contract initialized with empty bounties map and bountyCount = 0");
    }

    // Crear una nueva bounty con fondos adjuntos
    @call({payableFunction: true})
    create_bounty({prizes}: { prizes: string[] }): { bountyId: number } {
        const creator = near.predecessorAccountId(); // Obtener el ID de cuenta del creador
        const deposit = near.attachedDeposit(); // Obtener el depósito adjunto (fondos)

        // Validar que se proporcione un array de premios no vacío
        assert(
            Array.isArray(prizes) && prizes.length > 0,
            'Prizes must be a non-empty array.'
        );

        // Calcular el monto total del premio a partir del array de premios
        let totalPrize = BigInt(0);
        for (let prize of prizes) {
            totalPrize += BigInt(prize);
        }

        // Asegurarse de que el depósito adjunto coincida con el monto total del premio
        assert(
            deposit === totalPrize,
            'Attached deposit must equal the total prize amount.'
        );

        // Crear un nuevo objeto bounty
        const bounty: Bounty = {
            id: this.bountyCount,
            creator: creator,
            totalPrize: totalPrize.toString(), // Almacenar como cadena para compatibilidad con BigInt
            prizes: prizes.map((p) => BigInt(p).toString()), // Convertir premios a cadenas
            participants: [],
            winners: [],
            isActive: true,
        };

        // Almacenar la bounty e incrementar el contador
        this.bounties.set(this.bountyCount.toString(), bounty);
        near.log(`Bounty ${bounty.id} created by ${creator} with totalPrize ${bounty.totalPrize}`);
        this.bountyCount += 1;
        near.log(`bountyCount incremented to ${this.bountyCount}`);

        return {bountyId: bounty.id};
    }

    // Participar en una bounty activa
    @call({payableFunction: true})
    participate({bountyId}: { bountyId: number }): void {
        const participant = near.predecessorAccountId(); // Obtener el ID de cuenta del participante
        const bounty = this.bounties.get(bountyId.toString());

        // Asegurarse de que la bounty existe y está activa
        assert(bounty, 'Bounty does not exist.');
        assert(bounty.isActive, 'Bounty is no longer active.');

        // Agregar al participante si aún no está en la lista
        if (!bounty.participants.includes(participant)) {
            bounty.participants.push(participant);
            this.bounties.set(bountyId.toString(), bounty);
            near.log(`Participant ${participant} added to bounty ${bountyId}`);
        } else {
            near.log(`Participant ${participant} already entered bounty ${bountyId}`);
        }
    }

    // Finalizar la bounty y asignar ganadores
    @call({payableFunction: true})
    finalize_bounty({
                        bountyId,
                        winners,
                    }: {
        bountyId: number;
        winners: string[];
    }): void {
        const caller = near.predecessorAccountId(); // Obtener el ID de cuenta del que llama
        const bounty = this.bounties.get(bountyId.toString());

        // Asegurarse de que la bounty existe y está activa
        assert(bounty, 'Bounty does not exist.');
        assert(bounty.isActive, 'Bounty is already finalized.');

        // Solo el creador puede finalizar la bounty
        assert(
            caller === bounty.creator,
            'Only the bounty creator can finalize the bounty.'
        );

        // Validar que se proporcione un array de ganadores no vacío
        assert(
            Array.isArray(winners) && winners.length > 0,
            'Winners must be a non-empty array.'
        );

        // Asegurarse de que el número de premios coincide con el número de ganadores
        assert(
            bounty.prizes.length === winners.length,
            'The number of prizes must match the number of winners.'
        );

        // Verificar que cada ganador es un participante registrado
        for (let winner of winners) {
            assert(
                bounty.participants.includes(winner),
                `Winner ${winner} is not a registered participant.`
            );
        }

        // Asignar ganadores y desactivar la bounty
        bounty.winners = winners;
        bounty.isActive = false;
        this.bounties.set(bountyId.toString(), bounty);

        near.log(`Bounty ${bountyId} finalized by ${caller} with winners: ${winners.join(', ')}`);

        // Distribuir premios a los ganadores
        this._distribute_prizes(bounty);
    }

    // Distribuir premios a los ganadores
    private _distribute_prizes(bounty: Bounty): void {
        // Transferir premios a los ganadores
        for (let i = 0; i < bounty.winners.length; i++) {
            const winner = bounty.winners[i];
            const prizeAmount = BigInt(bounty.prizes[i]);

            // Transferir el monto del premio al ganador
            const promise = near.promiseBatchCreate(winner);
            near.promiseBatchActionTransfer(promise, prizeAmount);

            near.log(`Transferred ${prizeAmount.toString()} yoctoNEAR to winner: ${winner}`);
        }
    }

    // Ver una bounty específica
    @view({})
    get_bounty({bountyId}: { bountyId: number }): Bounty {
        const bounty = this.bounties.get(bountyId.toString());
        assert(bounty, 'Bounty does not exist.');
        near.log(`Retrieved bounty ${bountyId}`);
        return bounty;
    }

    // Ver todas las bounties
    @view({})
    get_all_bounties(): Bounty[] {
        const allBounties: Bounty[] = [];
        for (let i = 0; i < this.bountyCount; i++) {
            const bounty = this.bounties.get(i.toString());
            if (bounty) {
                allBounties.push(bounty);
            }
        }
        near.log(`Retrieved all bounties. Total count: ${allBounties.length}`);
        return allBounties;
    }

    @view({})
    get_participant_bounties({participantId}: { participantId: string }): Bounty[] {
        const participantBounties: Bounty[] = [];
        for (let i = 0; i < this.bountyCount; i++) {
            const bounty = this.bounties.get(i.toString());
            if (bounty && bounty.participants.includes(participantId)) {
                participantBounties.push(bounty);
            }
        }
        return participantBounties;
    }

    @view({})
    get_creator_bounties({creatorId}: { creatorId: string }): Bounty[] {
        const creatorBounties: Bounty[] = [];
        for (let i = 0; i < this.bountyCount; i++) {
            const bounty = this.bounties.get(i.toString());
            if (bounty && bounty.creator === creatorId) {
                creatorBounties.push(bounty);
            }
        }
        return creatorBounties;
    }
}
