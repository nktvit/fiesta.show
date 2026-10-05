import { md5 } from './music-md5';

describe('md5', () => {
  it('matches the RFC 1321 vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('hashes non-ASCII text as UTF-8', () => {
    // Reference value from node's crypto for 'é ✓ 😀'.
    expect(md5('é ✓ 😀')).toBe('430df118d0796f9a31c29667a958e940');
  });
});
