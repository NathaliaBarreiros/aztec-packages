import { randomBytes } from '@aztec/foundation/crypto';
import { Fr } from '@aztec/foundation/fields';
import type { Tuple } from '@aztec/foundation/serialize';
import { setupCustomSnapshotSerializers } from '@aztec/foundation/testing';
import { FunctionSelector } from '@aztec/stdlib/abi';
import { ContractClassLog } from '@aztec/stdlib/logs';

import { getSampleUnconstrainedFunctionBroadcastedEventPayload } from '../tests/fixtures.js';
import {
  BroadcastedUnconstrainedFunction,
  UnconstrainedFunctionBroadcastedEvent,
} from './unconstrained_function_broadcasted_event.js';

describe('UnconstrainedFunctionBroadcastedEvent', () => {
  beforeAll(() => setupCustomSnapshotSerializers(expect));

  it('parses an event as emitted by the ContractClassRegisterer', () => {
    const log = ContractClassLog.fromBuffer(getSampleUnconstrainedFunctionBroadcastedEventPayload());
    expect(UnconstrainedFunctionBroadcastedEvent.isUnconstrainedFunctionBroadcastedEvent(log)).toBe(true);

    const event = UnconstrainedFunctionBroadcastedEvent.fromLog(log);
    expect(event).toMatchSnapshot();
  });

  it('filters out zero-elements at the end of the artifact tree sibling path', () => {
    const siblingPath: Tuple<Fr, 5> = [Fr.ZERO, new Fr(1), Fr.ZERO, new Fr(2), Fr.ZERO];
    const event = new UnconstrainedFunctionBroadcastedEvent(
      Fr.random(),
      Fr.random(),
      Fr.random(),
      siblingPath,
      0,
      new BroadcastedUnconstrainedFunction(FunctionSelector.random(), Fr.random(), randomBytes(32)),
    );
    const filtered = event.toFunctionWithMembershipProof().artifactTreeSiblingPath;
    expect(filtered).toEqual([Fr.ZERO, new Fr(1), Fr.ZERO, new Fr(2)]);
  });
});
