/**
 * Module mã hóa/giải mã backup
 *
 * Dùng AES-256-GCM (authenticated encryption):
 *   - Dữ liệu được mã hóa + kèm auth tag 16 byte.
 *   - Nếu file bị hỏng hoặc bị sửa/tam đổi, giải mã sẽ THẤT BẠI (authentication error),
 *     tức là không thể lấy ra dữ liệu sai/lỗi mà không bị phát hiện.
 *
 * File .zip được dùng làm container: nén trước (deflate) -> mã hóa ciphertext ->
 * đóng gói lại thành .zip với entry "backup.enc" chứa ciphertext.
 * Nhờ vậy file .zip vẫn mở được bằng WinRAR/7-Zip để xem metadata, nhưng nội dung
 * vẫn phải cần password để giải mã.
 */

const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const archiver = require("archiver");
const extractZip = require("extract-zip");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bit
const IV_LENGTH = 12; // 96 bit - chuẩn cho GCM
const AUTH_TAG_LENGTH = 16; // 128 bit
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 310000;
const PBKDF2_DIGEST = "sha512";
const ENCRYPTED_ENTRY_NAME = "backup.enc";

/**
 * Lấy mật khẩu từ biến môi trường.
 * Hỗ trợ cả dạng chuỗi đơn giản và dạng "saltHex:keyHex" để người dùng
 * tự quản lý key hoàn toàn (không phụ thuộc .env).
 */
function getEncryptionKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw || !raw.trim()) {
    return null;
  }
  return raw.trim();
}

/**
 * Dẫn xuất key 32 byte từ mật khẩu bằng PBKDF2-SHA512.
 * Salt được sinh ngẫu nhiên mỗi lần mã hóa -> cùng 1 mật khẩu tạo ra ciphertext khác nhau.
 */
async function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST,
      (err, derivedKey) => (err ? reject(err) : resolve(derivedKey))
    );
  });
}

/**
 * Mã hóa buffer bằng AES-256-GCM.
 * @returns {Promise<{ciphertext: Buffer, authTag: Buffer, iv: Buffer}>}
 */
async function encryptBuffer(plainBuffer, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plainBuffer),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return { ciphertext, authTag, iv };
}

/**
 * Giải mã buffer bằng AES-256-GCM.
 * Nếu dữ liệu bị hỏng / tam đổi / sai mật khẩu -> throw error (KHÔNG trả về dữ liệu sai).
 */
async function decryptBuffer(ciphertext, key, iv, authTag) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  decipher.setAuthTag(authTag);

  const plainBuffer = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plainBuffer;
}

/**
 * Tạo header chứa metadata của file mã hóa.
 * Layout nhị phân của file .enc:
 *   [MAGIC(4)][VERSION(1)][ALGO(1)][SALT_LEN(1)][IV_LEN(1)][TAG_LEN(1)][SALT][IV][AUTH_TAG][CIPHERTEXT]
 */
function buildHeader({ salt, iv, authTag }) {
  const header = Buffer.alloc(7);
  header.write("BKPE", 0, 4, "ascii");
  header.writeUInt8(1, 4); // version
  header.writeUInt8(1, 5); // algo id: 1 = aes-256-gcm
  header.writeUInt8(salt.length, 6);

  // salt len đã nằm trong header, các độ dài còn lại cố định theo chuẩn GCM
  return Buffer.concat([header, salt, iv, authTag]);
}

/**
 * Đọc + phân tích header, trả về metadata và vị trí bắt đầu ciphertext.
 */
function parseHeader(buffer) {
  if (buffer.length < 7) {
    throw new Error("File mã hóa quá nhỏ / không hợp lệ");
  }

  const magic = buffer.subarray(0, 4).toString("ascii");
  if (magic !== "BKPE") {
    throw new Error(
      `Định dạng file không hợp lệ (magic=${magic}). Không phải file backup mã hóa.`
    );
  }

  const version = buffer.readUInt8(4);
  if (version !== 1) {
    throw new Error(`Phiên bản file mã hóa không được hỗ trợ: ${version}`);
  }

  const algo = buffer.readUInt8(5);
  if (algo !== 1) {
    throw new Error(`Thuật toán mã hóa không được hỗ trợ: ${algo}`);
  }

  const saltLength = buffer.readUInt8(6);
  const ivLength = IV_LENGTH;
  const tagLength = AUTH_TAG_LENGTH;

  let offset = 7;
  const salt = buffer.subarray(offset, offset + saltLength);
  offset += saltLength;
  const iv = buffer.subarray(offset, offset + ivLength);
  offset += ivLength;
  const authTag = buffer.subarray(offset, offset + tagLength);
  offset += tagLength;

  return {
    version,
    algo,
    salt,
    iv,
    authTag,
    ciphertextOffset: offset,
  };
}

/**
 * Nén một thư mục thành buffer zip (deflate), không ghi ra disk.
 */
function zipDirectoryToBuffer(sourceDir) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver("zip", {
      zlib: { level: 9 },
      // Không dùng store, luôn deflate -> giảm kích thước trước khi mã hóa
    });

    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("warning", (err) => {
      if (err.code !== "ENOENT") {
        reject(err);
      }
    });

    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * Giải nén buffer zip ra thư mục đích.
 */
async function unzipBufferToDirectory(zipBuffer, destDir) {
  const absDest = path.resolve(destDir);
  await fs.mkdir(absDest, { recursive: true });
  // extract-zip yêu cầu file trên disk, nên tạm ghi rồi xóa
  const tmpZip = path.join(absDest, "__tmp_extract__.zip");
  await fs.writeFile(tmpZip, zipBuffer);
  try {
    await extractZip(tmpZip, { dir: absDest });
  } finally {
    await fs.rm(tmpZip, { force: true });
  }
}

/**
 * Tạo file backup .zip đã mã hóa từ một thư mục backup.
 *
 * @param {string} sourceDir  Thư mục backup nguồn (chứa database/, metadata.json, ...)
 * @param {string} outputPath Đường dẫn file .zip đầu ra
 * @param {string} password   Mật khẩu (nếu undefined sẽ lấy từ BACKUP_ENCRYPTION_KEY)
 * @returns {Promise<{path: string, size: number}>}
 */
async function encryptDirectory(sourceDir, outputPath, password) {
  const pass = password ?? getEncryptionKey();
  if (!pass) {
    throw new Error(
      "Chưa cấu hình khóa mã hóa. Đặt BACKUP_ENCRYPTION_KEY trong .env hoặc truyền password."
    );
  }

  console.log("   🔐 Đang nén và mã hóa (AES-256-GCM)...");
  const zipBuffer = await zipDirectoryToBuffer(sourceDir);

  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await deriveKey(pass, salt);
  const { ciphertext, authTag, iv } = await encryptBuffer(zipBuffer, key);

  const header = buildHeader({ salt, iv, authTag });
  const payload = Buffer.concat([header, ciphertext]);

  // Gói payload vào 1 file zip để vẫn giữ đuôi .zip (mở được bằng WinRAR/7-Zip)
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await writeEncryptedZip(outputPath, payload);

  return { path: outputPath, size: payload.length };
}

/**
 * Ghi payload mã hóa vào 1 file .zip (entry tên "backup.enc").
 */
async function writeEncryptedZip(outputPath, payload) {
  return new Promise((resolve, reject) => {
    const output = require("fs").createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 0 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.append(payload, { name: ENCRYPTED_ENTRY_NAME });
    archive.finalize();
  });
}

/**
 * Giải mã 1 file backup .zip đã mã hóa -> trả về thư mục đã giải nén.
 *
 * @param {string} encryptedZipPath Đường dẫn file .zip mã hóa
 * @param {string} destDir          Thư mục đích sẽ chứa dữ liệu đã giải nén
 * @param {string} password         Mật khẩu (nếu undefined sẽ lấy từ BACKUP_ENCRYPTION_KEY)
 */
async function decryptZipToDirectory(encryptedZipPath, destDir, password) {
  const pass = password ?? getEncryptionKey();
  if (!pass) {
    throw new Error(
      "Chưa cấu hình khóa mã hóa. Đặt BACKUP_ENCRYPTION_KEY trong .env hoặc truyền password."
    );
  }

  // 1. Mở file .zip và lấy ra entry "backup.enc"
  const zipBuffer = await fs.readFile(encryptedZipPath);
  const tmpDir = path.join(
    path.dirname(path.resolve(encryptedZipPath)),
    `__decrypt_tmp_${Date.now()}`
  );
  let payload;

  try {
    await unzipBufferToDirectory(zipBuffer, tmpDir);
    const encPath = path.join(tmpDir, ENCRYPTED_ENTRY_NAME);
    payload = await fs.readFile(encPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  // 2. Parse header + giải mã
  const { salt, iv, authTag, ciphertextOffset } = parseHeader(payload);
  const key = await deriveKey(pass, salt);
  const ciphertext = payload.subarray(ciphertextOffset);

  // 3. Giải mã (sẽ throw nếu sai khóa / file hỏng / bị tam đổi)
  const zipPlainBuffer = await decryptBuffer(ciphertext, key, iv, authTag);

  // 4. Giải nén ra thư mục đích
  await unzipBufferToDirectory(zipPlainBuffer, destDir);

  return destDir;
}

module.exports = {
  encryptDirectory,
  decryptZipToDirectory,
  encryptBuffer,
  decryptBuffer,
  getEncryptionKey,
  // export nội bộ để test
  _internal: {
    zipDirectoryToBuffer,
    unzipBufferToDirectory,
    parseHeader,
    buildHeader,
  },
};