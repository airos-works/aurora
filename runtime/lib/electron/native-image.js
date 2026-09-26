'use strict';

// nativeImage: images are kept as encoded bytes; sizes come from PNG and
// JPEG headers. Aurora does not draw them itself (window icons come from the
// application's resources on Haiku).

const fs = require('fs');

function imageSize(buffer) {
  if (!buffer || buffer.length < 24)
    return { width: 0, height: 0 };
  if (buffer.readUInt32BE(0) === 0x89504e47)
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff)
        break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3)
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  return { width: 0, height: 0 };
}

class NativeImage {
  constructor(buffer, mimeType = 'image/png') {
    this._buffer = buffer || Buffer.alloc(0);
    this._mimeType = mimeType;
    this._template = false;
  }

  isEmpty() { return this._buffer.length === 0; }
  getSize() { return imageSize(this._buffer); }
  getAspectRatio() { const size = this.getSize(); return size.height ? size.width / size.height : 1; }
  getScaleFactors() { return [1]; }
  toPNG() { return Buffer.from(this._buffer); }
  toJPEG() { return Buffer.from(this._buffer); }
  toBitmap() { return Buffer.alloc(0); }
  getBitmap() { return Buffer.alloc(0); }
  toDataURL() { return this.isEmpty() ? 'data:image/png;base64,' : `data:${this._mimeType};base64,${this._buffer.toString('base64')}`; }
  getNativeHandle() { return Buffer.alloc(8); }
  resize() { return this; }
  crop() { return this; }
  addRepresentation() {}
  setTemplateImage(flag) { this._template = !!flag; }
  isTemplateImage() { return this._template; }
  get isMacTemplateImage() { return this._template; }
  set isMacTemplateImage(flag) { this._template = !!flag; }
}

const nativeImage = {
  createEmpty: () => new NativeImage(),
  createFromPath(file) {
    try {
      const data = fs.readFileSync(file);
      return new NativeImage(data, /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png');
    } catch {
      return new NativeImage();
    }
  },
  createFromBuffer: (buffer) => new NativeImage(Buffer.from(buffer)),
  createFromBitmap: () => new NativeImage(),
  createFromDataURL(url) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url));
    if (!match)
      return new NativeImage();
    const data = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
    return new NativeImage(data, match[1] || 'image/png');
  },
  createFromNamedImage: () => new NativeImage(),
  createThumbnailFromPath: (file) => Promise.resolve(nativeImage.createFromPath(file)),
};

module.exports = { nativeImage, NativeImage };
