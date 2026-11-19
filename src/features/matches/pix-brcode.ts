// Static Pix BR Code (EMV QRCPS-MPM, Manual de Padrões para Iniciação do Pix,
// Banco Central). Built only in the client, from the instruction the gateway
// opened; nothing here is sent anywhere. The key, the receiver name and the
// city arrive already normalised by the Edge (docs/13 section 1.3.2), so this
// module only lays out the fields and computes the CRC.

export interface PixPayment {
  /** Pix key in the normalised form: digits, +55 phone, lower-case e-mail or UUID. */
  readonly key: string;
  /** Upper case A-Z, 0-9 and spaces, at most 25 characters. */
  readonly receiverName: string;
  /** Upper case A-Z, 0-9 and spaces, at most 15 characters. */
  readonly receiverCity: string;
  /** Decimal with two places, as the gateway sends it ("17.50"), or null for none. */
  readonly amount: string | null;
}

function field(id: string, value: string): string {
  if (value.length > 99) throw new Error(`BR Code field ${id} is too long`);
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), four upper-case hex digits. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let index = 0; index < payload.length; index += 1) {
    crc ^= payload.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function pixBrCode(payment: PixPayment): string {
  if (!/^[\x20-\x7e]+$/.test(payment.key)) throw new Error('Pix key must be printable ASCII');
  if (!/^[A-Za-z0-9 ]{1,25}$/.test(payment.receiverName)) throw new Error('Invalid receiver');
  if (!/^[A-Za-z0-9 ]{1,15}$/.test(payment.receiverCity)) throw new Error('Invalid city');
  if (payment.amount !== null && !/^\d{1,10}\.\d{2}$/.test(payment.amount)) {
    throw new Error('Invalid amount');
  }
  const positive = payment.amount !== null && Number(payment.amount) > 0;
  const body =
    field('00', '01') +
    field('26', field('00', 'br.gov.bcb.pix') + field('01', payment.key)) +
    field('52', '0000') +
    field('53', '986') +
    (positive ? field('54', payment.amount as string) : '') +
    field('58', 'BR') +
    field('59', payment.receiverName) +
    field('60', payment.receiverCity) +
    field('62', field('05', '***')) +
    '6304';
  return body + crc16(body);
}
