// One request, tried in order. Transmitting is not proof of delivery.
export async function deliverRequest(message, routes) {
  try {
    const receipt = await routes.internet(message);
    if (receipt?.state !== 'dashboard_received' || receipt.message_id !== message.message_id) throw new Error('Invalid receipt');
    await routes.received(receipt);
    return 'dashboard_received';
  } catch { /* Continue with the same saved request and frame. */ }
  if (routes.state() !== 'queued') return routes.state();
  if (routes.bluetooth) {
    try { await routes.bluetooth(message); await routes.waitForReceipt(); } catch { /* Sound is the last local route. */ }
    if (routes.state() !== 'queued') return routes.state();
  }
  if (routes.sound) await routes.sound(message);
  return routes.state();
}
