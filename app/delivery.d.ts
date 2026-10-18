import type { Envelope, Delivery } from '../web/src/resident/transport';
type State = Delivery['state'];
type Receipt = { message_id: string; state: string; packet_id?: string };
export function deliverRequest(message: Envelope, routes: {
  internet: (message: Envelope) => Promise<Receipt>;
  received: (receipt: Receipt) => Promise<void>;
  state: () => State;
  bluetooth?: (message: Envelope) => Promise<void>;
  waitForReceipt: () => Promise<void>;
  sound?: (message: Envelope) => Promise<void>;
}): Promise<State>;
