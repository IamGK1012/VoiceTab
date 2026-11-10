import { RequestError } from './menu.mjs';

export const defaultBrand = { name: 'Lemon Club', color: '#2f5bff', font: 'modern', mark: 'tile', logo: '' };

export function validateBrand(input) {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  const { color, font, mark, logo } = input;
  if (!name || name.length > 40) throw new RequestError(400, 'Enter a stall name of 1–40 characters.');
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new RequestError(400, 'Choose a valid brand color.');
  if (!['modern', 'editorial', 'counter'].includes(font)) throw new RequestError(400, 'Choose one of the font pairings.');
  if (!['tile', 'round', 'stamp', 'upload'].includes(mark)) throw new RequestError(400, 'Choose a logo style.');
  if (mark !== 'upload') return { name, color: color.toLowerCase(), font, mark, logo: '' };

  if (typeof logo !== 'string' || logo.length > 250_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(logo)) {
    throw new RequestError(400, 'Upload a PNG, JPEG, or WebP logo first.');
  }
  const png = Buffer.from(logo.slice('data:image/png;base64,'.length), 'base64');
  if (png.length < 45 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR' ||
      png.readUInt32BE(16) !== 192 || png.readUInt32BE(20) !== 192) {
    throw new RequestError(400, 'The logo could not be read. Choose another image.');
  }
  return { name, color: color.toLowerCase(), font, mark, logo };
}
