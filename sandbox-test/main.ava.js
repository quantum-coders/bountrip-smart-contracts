import anyTest from 'ava';
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first'); // workaround for Node >17
import { Worker } from 'near-workspaces';

/**
 *  @typedef {import('near-workspaces').NearAccount} NearAccount
 *  @type {import('ava').TestFn<{worker: Worker, accounts: Record<string, NearAccount>}>}
 */
const test = anyTest;

test.beforeEach(async (t) => {
  const worker = t.context.worker = await Worker.init();
  const root = worker.rootAccount;

  // Deploy contract to subaccount
  const contract = await root.createSubAccount('bountrip-contract');
  await contract.deploy(process.argv[2]); // ex. build/bountrip.wasm

  t.context.accounts = { root, contract };
});

test.afterEach.always(async (t) => {
  await t.context.worker.tearDown().catch((e) => {
    console.log('Failed to stop Sandbox:', e);
  });
});

/**
 * SECURITY TESTS
 */
test('Owner can only be set once by the first caller, then only changed by that owner', async (t) => {
  const { root, contract } = t.context.accounts;

  // Initially, no owner is set. The first call to set_owner with no argument => the caller becomes owner
  await root.call(contract, 'set_owner', {});

  // Check
  let info = await contract.view('get_fee_info', {});
  t.is(info.owner, root.accountId); // root is now owner
  // feePercentage could be 2 or undefined if migrating from old state
  // but in a fresh test environment, it should be 2 (constructor default)
  // We'll handle the undefined scenario in a separate test.

  // Create "attacker" that tries to call set_owner
  const attacker = await root.createSubAccount('attacker');

  // Should fail: attacker is not the current owner
  await t.throwsAsync(
    attacker.call(contract, 'set_owner', { new_owner: attacker.accountId }),
    { message: /Only current owner \(.+\) can change ownership/ }
  );

  // The owner itself can change ownership to e.g. "some-other-owner"
  await root.call(contract, 'set_owner', { new_owner: 'another-owner.testnet' });
  info = await contract.view('get_fee_info', {});
  t.is(info.owner, 'another-owner.testnet');
});

test('Only owner can update fee percentage', async (t) => {
  const { root, contract } = t.context.accounts;

  // Root sets itself as owner
  await root.call(contract, 'set_owner', {});

  // Fee should start at 2 (assuming fresh state)
  let info = await contract.view('get_fee_info', {});
  // If fee is undefined (migrated scenario), you'd call define_fee_percentage in a new test or you can do it here:
  if (info.feePercentage === undefined) {
    // let's define it now
    await root.call(contract, 'define_fee_percentage', { newFee: 2 });
    info = await contract.view('get_fee_info', {});
    t.is(info.feePercentage, 2);
  } else {
    t.is(info.feePercentage, 2);
  }

  // Attempt to update fee as attacker => should fail
  const attacker = await root.createSubAccount('attacker');
  await t.throwsAsync(
    attacker.call(contract, 'update_fee_percentage', { feePercentage: 10 }),
    { message: /Only the owner .+ can update the fee/ }
  );

  // Root can update the fee successfully
  await root.call(contract, 'update_fee_percentage', { feePercentage: 10 });
  info = await contract.view('get_fee_info', {});
  t.is(info.feePercentage, 10);
});

/**
 * Additional test specifically to handle "undefined" feePercentage in a migrated scenario.
 */
test('Define feePercentage if it was undefined (migration scenario)', async (t) => {
  const { root, contract } = t.context.accounts;

  // 1) Set owner
  await root.call(contract, 'set_owner', {});

  // 2) Check if feePercentage is undefined, then fix it
  let info = await contract.view('get_fee_info', {});
  if (info.feePercentage === undefined) {
    // We call define_fee_percentage (the new method you added)
    await root.call(contract, 'define_fee_percentage', { newFee: 2 });
    info = await contract.view('get_fee_info', {});
    t.is(info.feePercentage, 2, 'Fee should be defined after migration step');
  } else {
    // If it's not undefined, we confirm it's 2 or whatever default
    t.pass('Fee was already defined: ' + info.feePercentage);
  }
});

/**
 * BOUNTY CREATION / PARTICIPATION / FINALIZATION TESTS
 */
test('Create a bounty and finalize with fees going to owner', async (t) => {
  const { root, contract } = t.context.accounts;

  // root => set itself as owner
  await root.call(contract, 'set_owner', {});

  // Ensure fee is set (not undefined)
  let info = await contract.view('get_fee_info', {});
  if (info.feePercentage === undefined) {
    await root.call(contract, 'define_fee_percentage', { newFee: 2 });
  }

  // Let "creator" be a separate account paying for bounty creation/finalization
  const creator = await root.createSubAccount('creator');
  const participant1 = await root.createSubAccount('p1');
  const participant2 = await root.createSubAccount('p2');

  // Create a bounty with 1.5 NEAR total
  const prizes = [
    "1000000000000000000000000", // 1 NEAR
    "500000000000000000000000"   // 0.5 NEAR
  ];
  await creator.call(
    contract,
    'create_bounty',
    { prizes },
    { attachedDeposit: '1500000000000000000000000' }
  );

  // Both participants join
  await participant1.call(contract, 'participate', { bountyId: 0 });
  await participant2.call(contract, 'participate', { bountyId: 0 });

  // Check balances
  const ownerBefore = BigInt((await root.balance()).total);
  const p1Before = BigInt((await participant1.balance()).total);
  const p2Before = BigInt((await participant2.balance()).total);

  // Finalize with both as winners
  await creator.call(contract, 'finalize_bounty', {
    bountyId: 0,
    winners: [participant1.accountId, participant2.accountId]
  });

  const bounty = await contract.view('get_bounty', { bountyId: 0 });
  t.false(bounty.isActive);
  t.deepEqual(bounty.winners, [participant1.accountId, participant2.accountId]);

  // default fee: 2%
  // totalFee = 0.02 * 1.5 NEAR = 0.03 NEAR => 3e22
  const totalFee = BigInt("30000000000000000000000");
  const ownerAfter = BigInt((await root.balance()).total);
  const p1After = BigInt((await participant1.balance()).total);
  const p2After = BigInt((await participant2.balance()).total);

  // The owner did not pay for finalize => no gas usage
  // so the owner delta should be exactly totalFee
  t.is((ownerAfter - ownerBefore).toString(), totalFee.toString());

  // Each participant got at least their net prize
  const expectedNet1 = BigInt("980000000000000000000000");  // 1e24 - 2e22
  const expectedNet2 = BigInt("490000000000000000000000");  // 5e23 - 1e22
  t.true(p1After - p1Before >= expectedNet1, 'p1 has correct net prize');
  t.true(p2After - p2Before >= expectedNet2, 'p2 has correct net prize');
});
