// Borradores del módulo de vigilancia.
//
// En tablets Android con poca RAM, abrir la cámara nativa (input capture) hace que
// el sistema mate el proceso de la PWA para liberar memoria; al volver de la cámara
// la página arranca de cero y el guardia pierde el registro a medias. Todo lo que
// captura se respalda aquí — textos en localStorage y fotos en IndexedDB (sobreviven
// al kill del proceso) — y la página lo restaura al montar.

const LS_KEY = "vigilancia_borrador";
const DB_NAME = "vecinity-vigilancia";
const STORE = "fotos";
// Un borrador más viejo que esto ya no es una captura "a medias": se descarta.
const TTL_MS = 60 * 60 * 1000;

const LADO_MAX = 1280;
const CALIDAD_JPEG = 0.72;

/**
 * Reduce la foto a máx. 1280px por lado (JPEG). Una foto de cámara de 8–12 MP pesa
 * varios MB y su decodificación dispara el uso de memoria justo cuando la tablet
 * viene de abrir la cámara. Fail open: si algo falla se sube la original.
 */
export async function comprimirFoto(original: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(original);
    const escala = Math.min(1, LADO_MAX / Math.max(bitmap.width, bitmap.height));
    const ancho = Math.max(1, Math.round(bitmap.width * escala));
    const alto = Math.max(1, Math.round(bitmap.height * escala));
    const canvas = document.createElement("canvas");
    canvas.width = ancho;
    canvas.height = alto;
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    ctx.drawImage(bitmap, 0, 0, ancho, alto);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", CALIDAD_JPEG)
    );
    if (!blob || blob.size >= original.size) return original;
    return new File([blob], "foto.jpg", { type: "image/jpeg" });
  } catch {
    return original;
  }
}

// --- Textos (localStorage) ---

export function guardarBorradorTexto(campos: Record<string, unknown>) {
  try {
    const vacio = Object.values(campos).every((v) => v == null || v === "");
    if (vacio) {
      localStorage.removeItem(LS_KEY);
      return;
    }
    localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), campos }));
  } catch {
    /* almacenamiento lleno o bloqueado: el flujo sigue, solo sin respaldo */
  }
}

export function leerBorradorTexto(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const borrador = JSON.parse(raw) as { ts?: number; campos?: Record<string, unknown> };
    if (!borrador?.campos || Date.now() - (borrador.ts ?? 0) > TTL_MS) {
      localStorage.removeItem(LS_KEY);
      return null;
    }
    return borrador.campos;
  } catch {
    return null;
  }
}

// --- Fotos (IndexedDB) ---

type FotoGuardada = { blob: Blob; name: string; ts: number };

function abrirDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function guardarFotoDraft(key: string, file: File) {
  try {
    const db = await abrirDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ blob: file, name: file.name, ts: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* sin respaldo */
  }
}

export async function borrarFotoDraft(...keys: string[]) {
  try {
    const db = await abrirDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      for (const key of keys) tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

/** Devuelve las fotos vigentes del borrador y purga las que ya caducaron. */
export async function leerFotosDraft(): Promise<Record<string, File>> {
  try {
    const db = await abrirDb();
    const fotos: Record<string, File> = {};
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const cursorReq = tx.objectStore(STORE).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const valor = cursor.value as FotoGuardada;
        if (!valor?.blob || Date.now() - (valor.ts ?? 0) > TTL_MS) {
          cursor.delete();
        } else {
          fotos[String(cursor.key)] = new File([valor.blob], valor.name || "foto.jpg", {
            type: valor.blob.type || "image/jpeg",
          });
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return fotos;
  } catch {
    return {};
  }
}
