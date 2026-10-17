// Extrae el texto de un CV (PDF, DOCX, TXT o MD) en el navegador; el archivo no se sube.
const CV_MAX_BYTES = 8 * 1024 * 1024;
const CV_MAX_CHARS = 60000;

async function cvExtraer(file) {
  if (file.size > CV_MAX_BYTES) throw new Error('El archivo supera los 8 MB.');
  const nombre = file.name.toLowerCase();
  let texto;
  if (nombre.endsWith('.pdf')) texto = await cvDePdf(file);
  else if (nombre.endsWith('.docx')) texto = await cvDeDocx(file);
  else if (nombre.endsWith('.txt') || nombre.endsWith('.md')) texto = await file.text();
  else throw new Error('Formato no soportado. Usá PDF, DOCX, TXT o MD (o pegá el texto).');
  texto = texto.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (texto.length < 80) throw new Error('No pude leer texto del archivo (¿es un PDF escaneado?). Pegá el texto a mano.');
  return texto.slice(0, CV_MAX_CHARS);
}

async function cvDePdf(file) {
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', location.href).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const paginas = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    let s = '';
    tc.items.forEach(it => { s += it.str + (it.hasEOL ? '\n' : ' '); });
    paginas.push(s);
  }
  return paginas.join('\n\n');
}

async function cvDeDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El archivo no es un DOCX válido.');
  let p = dv.getUint32(eocd + 16, true);
  const total = dv.getUint16(eocd + 10, true);
  const dec = new TextDecoder();
  for (let n = 0; n < total && dv.getUint32(p, true) === 0x02014b50; n++) {
    const metodo = dv.getUint16(p + 10, true);
    const comp = dv.getUint32(p + 20, true);
    const lnom = dv.getUint16(p + 28, true), lext = dv.getUint16(p + 30, true), lcom = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const nom = dec.decode(buf.subarray(p + 46, p + 46 + lnom));
    if (nom === 'word/document.xml') {
      const ini = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      let datos = buf.subarray(ini, ini + comp);
      if (metodo === 8) {
        datos = new Uint8Array(await new Response(new Blob([datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      } else if (metodo !== 0) throw new Error('DOCX con compresión no soportada.');
      const xml = dec.decode(datos);
      return xml
        .replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    }
    p += 46 + lnom + lext + lcom;
  }
  throw new Error('No encontré el contenido del DOCX.');
}
