/**
 * Decode UsdcPayPerRequest custom errors into user-facing sentences.
 */
import { formatEther } from 'viem';
import { formatAddr } from './format';

export function decodeContractError(err: unknown): string {
  if (!err) return 'Unknown error.';
  const msg = (err as { message?: string; shortMessage?: string })?.shortMessage
    || (err as { message?: string })?.message
    || (typeof err === 'object' && err !== null && 'toString' in err ? (err as { toString(): string }).toString() : 'Unknown error');

  if (msg.includes('user rejected') || msg.includes('User rejected') || msg.includes('4001')) {
    return 'Transaction cancelled.';
  }

  // WrongAmount(sent, price)
  const wrongAmount = msg.match(/WrongAmount[^(]*\(([\d]+),\s*([\d]+)\)/);
  if (wrongAmount) {
    const sent = BigInt(wrongAmount[1]);
    const price = BigInt(wrongAmount[2]);
    return `Price is ${formatEther(price)} USDC, you sent ${formatEther(sent)} USDC. Request a new quote.`;
  }

  // AlreadyPaid(requestId)
  if (msg.includes('AlreadyPaid')) {
    return 'This request was already paid — the contract never charges twice.';
  }

  // RequestNotForPayer(boundPayer)
  const notForPayer = msg.match(/RequestNotForPayer[^(]*\((0x[0-9a-fA-F]{40})\)/);
  if (notForPayer) {
    return `This requestId belongs to ${formatAddr(notForPayer[1])} — only that address can pay it.`;
  }

  // EndpointInactive(id)
  if (msg.includes('EndpointInactive')) {
    return 'The provider paused this endpoint. Try again later.';
  }

  // UnknownEndpoint(id)
  if (msg.includes('UnknownEndpoint')) {
    return 'Endpoint not found. Double-check the endpoint ID.';
  }

  // InsufficientCredit(amount, credit)
  const insuf = msg.match(/InsufficientCredit[^(]*\(([\d]+),\s*([\d]+)\)/);
  if (insuf) {
    const need = BigInt(insuf[1]);
    const have = BigInt(insuf[2]);
    return `Insufficient credit: need ${formatEther(need)} USDC, have ${formatEther(have)} USDC.`;
  }

  // NotProvider
  if (msg.includes('NotProvider')) {
    return 'Only the endpoint provider can do this.';
  }

  // PayeeNotApproved(payee)
  if (msg.includes('PayeeNotApproved')) {
    return 'This payee has not approved you as a provider. Ask them to call approveProvider first.';
  }

  // AlreadyRefunded
  if (msg.includes('AlreadyRefunded')) {
    return 'This payment was already refunded.';
  }

  // UnknownPayment
  if (msg.includes('UnknownPayment')) {
    return 'This request has not been paid.';
  }

  // ZeroRequestId
  if (msg.includes('ZeroRequestId')) {
    return 'Request ID cannot be zero.';
  }

  // InvalidPrice
  if (msg.includes('InvalidPrice')) {
    return 'Price must be greater than zero.';
  }

  // InvalidName
  if (msg.includes('InvalidName')) {
    return 'Name must be between 1 and 64 bytes.';
  }

  // InvalidPayee / ZeroAddress
  if (msg.includes('InvalidPayee') || msg.includes('ZeroAddress')) {
    return 'Invalid address.';
  }

  // TransferFailed
  if (msg.includes('TransferFailed')) {
    return 'The transfer failed — the recipient may not be able to receive USDC.';
  }

  if (msg.includes('insufficient funds') || msg.includes('exceeds balance')) {
    return 'Insufficient USDC balance for this transaction.';
  }

  if (msg.includes('network') || msg.includes('timeout') || msg.includes('fetch')) {
    return 'Network error. Check your connection and retry.';
  }

  return msg.length > 120 ? msg.slice(0, 120) + '…' : msg;
}
