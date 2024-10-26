import anyTest from 'ava';
import { setDefaultResultOrder } from 'dns'; setDefaultResultOrder('ipv4first'); // Solución temporal para Node >v17
import { Worker } from 'near-workspaces';

/**
 *  @typedef {import('near-workspaces').NearAccount} NearAccount
 *  @type {import('ava').TestFn<{worker: Worker, accounts: Record<string, NearAccount>}>}
 */
const test = anyTest;

test.beforeEach(async (t) => {
  // Crear sandbox
  const worker = t.context.worker = await Worker.init();

  // Desplegar el contrato
  const root = worker.rootAccount;
  const contract = await root.createSubAccount('bountrip-contract');

  // Obtener la ruta del archivo wasm desde el script de prueba en package.json
  await contract.deploy(process.argv[2]);

  // Guardar el estado para las pruebas
  t.context.accounts = { root, contract };
});

test.afterEach.always(async (t) => {
  await t.context.worker.tearDown().catch((error) => {
    console.log('Failed to stop the Sandbox:', error);
  });
});

test('Crear una nueva bounty', async (t) => {
  const { root, contract } = t.context.accounts;

  // Definir los premios para la bounty
  const prizes = ["1000000000000000000000000", "500000000000000000000000"];

  // Llamar al método create_bounty con los premios y adjuntar el depósito total
  const result = await root.call(contract, 'create_bounty', { prizes }, { attachedDeposit: '1500000000000000000000000' });

  // Verificar que se haya creado la bounty correctamente
  t.is(result.bountyId, 0);

  // Obtener la bounty recién creada
  const bounty = await contract.view('get_bounty', { bountyId: 0 });

  // Verificar que los datos de la bounty sean correctos
  t.is(bounty.id, 0);
  t.is(bounty.creator, root.accountId);
  t.deepEqual(bounty.prizes, prizes);
  t.true(bounty.isActive);
});

test('Participar en una bounty', async (t) => {
  const { root, contract } = t.context.accounts;

  // Crear una bounty primero
  const prizes = ["1000000000000000000000000"];
  await root.call(contract, 'create_bounty', { prizes }, { attachedDeposit: '1000000000000000000000000' });

  // Crear una cuenta de participante
  const participant = await root.createSubAccount('participant');

  // El participante participa en la bounty
  await participant.call(contract, 'participate', { bountyId: 0 });

  // Obtener la bounty actualizada
  const bounty = await contract.view('get_bounty', { bountyId: 0 });

  // Verificar que el participante esté en la lista de participantes
  t.deepEqual(bounty.participants, [participant.accountId]);
});

test('Finalizar una bounty y distribuir premios', async (t) => {
  const { root, contract } = t.context.accounts;

  // Crear una bounty
  const prizes = ["1000000000000000000000000", "500000000000000000000000"];
  await root.call(contract, 'create_bounty', { prizes }, { attachedDeposit: '1500000000000000000000000' });

  // Crear cuentas de participantes
  const participant1 = await root.createSubAccount('participant1');
  const participant2 = await root.createSubAccount('participant2');

  // Participantes participan en la bounty
  await participant1.call(contract, 'participate', { bountyId: 0 });
  await participant2.call(contract, 'participate', { bountyId: 0 });

  // Finalizar la bounty y asignar ganadores
  const winners = [participant1.accountId, participant2.accountId];
  await root.call(contract, 'finalize_bounty', { bountyId: 0, winners });

  // Verificar que la bounty ya no está activa
  const bounty = await contract.view('get_bounty', { bountyId: 0 });
  t.false(bounty.isActive);
  t.deepEqual(bounty.winners, winners);

  // Verificar los saldos de los ganadores
  const balance1 = await participant1.balance();
  const balance2 = await participant2.balance();

  // Los balances deben haber incrementado en los montos de los premios
  // Nota: Es posible que necesites ajustar esto según las tarifas de gas y otros factores
  t.true(BigInt(balance1.total) > BigInt('1000000000000000000000000'));
  t.true(BigInt(balance2.total) > BigInt('500000000000000000000000'));
});

test('Solo el creador puede finalizar una bounty', async (t) => {
  const { root, contract } = t.context.accounts;

  // Crear una bounty
  const prizes = ["1000000000000000000000000"];
  await root.call(contract, 'create_bounty', { prizes }, { attachedDeposit: '1000000000000000000000000' });

  // Crear una cuenta que no es el creador
  const attacker = await root.createSubAccount('attacker');

  // Intentar finalizar la bounty con otra cuenta
  await t.throwsAsync(
    attacker.call(contract, 'finalize_bounty', { bountyId: 0, winners: [attacker.accountId] }),
    { instanceOf: Error, message: /Only the bounty creator can finalize the bounty./ }
  );
});
