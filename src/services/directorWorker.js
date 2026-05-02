export const directorWorkerCode = `
self.onmessage = async function(e) {
  const { id, type, payload } = e.data;
  if (!id) return;
  
  try {
    let result = null;
    switch(type) {
      case 'extractColor':
        result = await extractColor(payload);
        break;
      case 'autocrop':
        result = await autocrop(payload);
        break;
      case 'preBlur':
        result = await preBlur(payload);
        break;
      case 'parseMetadata':
        result = parseMetadata(payload);
        break;
      case 'measureText':
        result = measureText(payload);
        break;
      default:
        throw new Error('Unknown command: ' + type);
    }
    self.postMessage({ id, status: 'success', result });
  } catch (err) {
    self.postMessage({ id, status: 'error', error: err.message, fallback: err.fallback });
  }
};

async function extractColor({ blobUrl }) {
  const resp = await fetch(blobUrl);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob, { resizeWidth: 4, resizeHeight: 3 });
  const canvas = new OffscreenCanvas(4, 3);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const data = ctx.getImageData(0, 0, 4, 3).data;
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const red = data[i], green = data[i+1], blue = data[i+2];
    const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
    if (max - min > 15) { r += red; g += green; b += blue; count++; }
  }
  if (count === 0) {
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; count++; }
  }
  return count > 0 ? [Math.round(r / count), Math.round(g / count), Math.round(b / count)] : null;
}

async function autocrop({ blobUrl, step, alphaThreshold, pad }) {
  const resp = await fetch(blobUrl);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  const MAX_DIM = 800;
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  const imgData = ctx.getImageData(0, 0, w, h);
  const data = new Uint8ClampedArray(imgData.data.buffer);
  let top = h, bottom = 0, left = w, right = 0;
  let found = false;
  
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (data[(y * w + x) * 4 + 3] > alphaThreshold) {
        found = true;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (!found) return { croppedBlob: null };

  const cropTop = Math.max(0, top - pad);
  const cropBottom = Math.min(h - 1, bottom + pad);
  const cropLeft = Math.max(0, left - pad);
  const cropRight = Math.min(w - 1, right + pad);

  const cropWidth = cropRight - cropLeft + 1;
  const cropHeight = cropBottom - cropTop + 1;

  if (cropWidth <= 0 || cropHeight <= 0) return { croppedBlob: null };

  const outCanvas = new OffscreenCanvas(cropWidth, cropHeight);
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(canvas, cropLeft, cropTop, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  
  const croppedBlob = await outCanvas.convertToBlob({ type: 'image/png' });
  return { croppedBlob };
}

async function preBlur({ blobUrl, size, passes, blurRadius }) {
  const resp = await fetch(blobUrl);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  const scale = size / Math.max(bmp.width, bmp.height);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');

  // Use native canvas filter for GPU-accelerated blur
  // Each pass compounds the effect for a smoother result
  const radius = blurRadius || 20;
  for (let p = 0; p < passes; p++) {
    ctx.filter = 'blur(' + radius + 'px)';
    if (p === 0) {
      ctx.drawImage(bmp, 0, 0, w, h);
    } else {
      ctx.drawImage(canvas, 0, 0);
    }
  }
  ctx.filter = 'none';
  bmp.close();

  const blurredBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return { blurredBlob };
}

function parseMetadata({ jsonText }) {
  const data = JSON.parse(jsonText);
  // structuredClone captures all fields automatically,
  // so new Jellyfin API fields are included without manual mapping
  const fields = [
    'Id', 'Type', 'SeriesId', 'ParentId', 'Name', 'SeriesName',
    'ParentIndexNumber', 'IndexNumber', 'ProductionYear', 'OfficialRating',
    'Genres', 'CommunityRating', 'RunTimeTicks', 'Overview',
    'BackdropImageTags', 'ParentBackdropImageTags', 'ParentBackdropItemId',
    'Chapters'
  ];
  const subset = {};
  for (const key of fields) {
    if (data[key] !== undefined) subset[key] = data[key];
  }
  return typeof structuredClone === 'function' ? structuredClone(subset) : JSON.parse(JSON.stringify(subset));
}

function measureText({ text, fontFamily, width, minSize, maxSize, availableHeight, lineHeightMultiplier, measureScale }) {
  if (typeof OffscreenCanvas === "undefined") {
    const err = new Error("No OffscreenCanvas support");
    err.fallback = true;
    throw err;
  }

  // Scale up for hi-DPI precision: font metrics are more accurate at larger sizes.
  // The search runs in scaled space, the result is divided back to CSS px.
  const scale = (measureScale && measureScale > 0) ? measureScale : 1;
  const scaledWidth = width * scale;
  const scaledMin = minSize * scale;
  const scaledMax = maxSize * scale;
  const scaledAvailHeight = availableHeight * scale;

  // Basic string sanitization for measurement (strip html)
  const plainText = text.replace(/<[^>]+>/g, ' ');
  const words = plainText.split(/(?<=\\s)/);

  const canvas = new OffscreenCanvas(Math.max(1, scaledWidth), 100);
  const ctx = canvas.getContext('2d');

  let low = scaledMin, high = scaledMax, bestFit = scaledMin;
  const step = 0.25 * scale;

  while (low <= high) {
    const mid = low + (high - low) / 2;
    ctx.font = mid + "px " + fontFamily;
    const lineHeight = mid * lineHeightMultiplier;

    let currentLine = '';
    let totalHeight = lineHeight;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testLine = currentLine + word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > scaledWidth) {
        if (currentLine !== '') {
          totalHeight += lineHeight;
          currentLine = word;
        } else {
          currentLine = word;
        }

        // Approximate overflow-wrap for extremely long single words
        const wordMetrics = ctx.measureText(word);
        if (wordMetrics.width > scaledWidth) {
          const linesNeeded = Math.ceil(wordMetrics.width / scaledWidth);
          if (linesNeeded > 1) {
            totalHeight += lineHeight * (linesNeeded - 1);
          }
        }
      } else {
        currentLine = testLine;
      }
    }

    if (totalHeight <= scaledAvailHeight) {
      bestFit = mid;
      low = mid + step;
    } else {
      high = mid - step;
    }
  }
  return { bestFit: bestFit / scale };
}
`;
