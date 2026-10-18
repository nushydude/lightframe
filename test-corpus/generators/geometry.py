"""Authored CC0 geometry and rejection fixtures. Manual regeneration only.

JPEG uses Pillow (record its version when regenerating); other bytes use stdlib.
No external artwork, metadata, fonts, profiles or camera output is embedded here.
"""
from pathlib import Path
import struct
import io
from PIL import Image

root = Path(__file__).resolve().parents[1] / "fixtures"
root.mkdir(exist_ok=True)
def save(name, data):
    target = root / name
    if target.exists():
        if target.read_bytes() != data:
            raise RuntimeError(f"Refusing to overwrite immutable fixture {target}; create a new versioned candidate")
    else:
        target.write_bytes(data)

pixels = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])
image = Image.frombytes("RGB", (2, 2), pixels)
jpeg = io.BytesIO()
image.save(jpeg, format="JPEG", quality=95, subsampling=0, optimize=False, progressive=False)
save("geometry-v1.jpg", jpeg.getvalue())
# Baseline uncompressed RGB TIFF: ten IFD entries and one strip.
entries = [(256, 3, 1, 2), (257, 3, 1, 2), (258, 3, 3, 134),
           (259, 3, 1, 1), (262, 3, 1, 2), (273, 4, 1, 140),
           (277, 3, 1, 3), (278, 4, 1, 2), (279, 4, 1, 12), (284, 3, 1, 1)]
tiff = b"II" + struct.pack("<HIH", 42, 8, len(entries))
for tag, kind, count, value in entries:
    tiff += struct.pack("<HHII", tag, kind, count, value)
tiff += struct.pack("<IHHH", 0, 8, 8, 8) + pixels
save("geometry-v1.tiff", tiff)
# Flattened 8-bit RGB PSD with no resources, layers or metadata.
psd = b"8BPS" + struct.pack(">H6sHIIHH", 1, bytes(6), 3, 2, 2, 8, 3)
psd += bytes(12) + struct.pack(">H", 0)
psd += b"".join(pixels[channel::3] for channel in range(3))
save("geometry-v1.psd", psd)
save("rating-v1.xmp", b'''<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="3"/>
 </rdf:RDF>
</x:xmpmeta>
''')
# Intentionally incomplete signatures; rejection evidence only, never decoder evidence.
save("truncated-v1.jxl", bytes.fromhex("0000000c4a584c200d0a870a"))
save("truncated-v1.heic", bytes.fromhex("000000186674797068656963000000006d69663168656963"))
