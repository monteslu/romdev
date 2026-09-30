// Python codec names -> decoders, for the few text encodings splat decodes
// itself (the N64 header's internal name).
function pyCodecName(name) { return String(name).toLowerCase().replace(/_/g, '-'); }

export function decodeText(bytes, encoding) {
  const n = pyCodecName(encoding);
  if (n === 'ascii' || n === 'us-ascii' || n === '646') {
    for (const b of bytes) {
      if (b > 0x7f) throw new Error(`UnicodeDecodeError: 'ascii' codec can't decode byte 0x${b.toString(16)}`);
    }
    return Buffer.from(bytes).toString('latin1');
  }
  if (n === 'latin-1' || n === 'latin1' || n === 'iso-8859-1' || n === 'iso8859-1') return Buffer.from(bytes).toString('latin1');
  const map = {
    'utf-8': 'utf-8', utf8: 'utf-8',
    'shift-jis': 'shift_jis', 'shift_jis': 'shift_jis', sjis: 'shift_jis', 's-jis': 'shift_jis',
    'euc-jp': 'euc-jp', eucjp: 'euc-jp',
  };
  const label = map[n];
  if (!label) throw new Error(`romdev-splat: unsupported text encoding '${encoding}'`);
  return new TextDecoder(label, { fatal: true }).decode(bytes);
}
