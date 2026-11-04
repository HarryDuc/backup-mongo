/**
 * Công cụ giải mã file backup đã mã hóa (AES-256-GCM)
 *
 * Dùng khi muốn restore từ file backup .zip đã mã hóa:
 *   node decrypt-backup.cjs ./backups/backup-28-04-2026_10-08-38.zip --out ./restored
 *
 * Sau khi giải mã, dùng import-backup.cjs để import:
 *   node import-backup.cjs ./restored --all
 */

const fs = require("fs").promises;
const path = require("path");
const chalk = require("chalk");
const readline = require("readline");
const dotenv = require("dotenv");
const {
  decryptZipToDirectory,
  getEncryptionKey,
} = require("./backup-encryption.cjs");

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

function showUsage() {
  console.log(chalk.bold.blue("🔓 Giải mã file backup đã mã hóa"));
  console.log("");
  console.log(chalk.bold.yellow("Cách sử dụng:"));
  console.log(
    chalk.gray(
      "  node decrypt-backup.cjs <đường dẫn file .zip> [--out <thư mục đích>] [--password <mật khẩu>]"
    )
  );
  console.log("");
  console.log(chalk.bold.cyan("Tùy chọn:"));
  console.log(
    chalk.gray("  --out <dir>       Thư mục đích giải mã (mặc định: <tên file>-decrypted)")
  );
  console.log(
    chalk.gray("  --password <pwd>  Mật khẩu (mặc định: lấy từ BACKUP_ENCRYPTION_KEY trong .env)")
  );
  console.log("");
  console.log(chalk.bold.yellow("Ví dụ:"));
  console.log(
    chalk.gray(
      "  node decrypt-backup.cjs ./backups/backup-28-04-2026_10-08-38.zip --out ./restored"
    )
  );
}

function parseArguments() {
  const args = process.argv.slice(2);
  const options = {
    inputFile: null,
    outputDir: null,
    password: null,
    showHelp: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        options.showHelp = true;
        break;
      case "--out":
      case "--output":
        if (args[i + 1]) {
          options.outputDir = args[++i];
        }
        break;
      case "--password":
      case "-p":
        if (args[i + 1]) {
          options.password = args[++i];
        }
        break;
      default:
        if (!options.inputFile) {
          options.inputFile = arg;
        }
    }
  }

  return options;
}

async function main() {
  const options = parseArguments();

  if (options.showHelp) {
    showUsage();
    process.exit(0);
  }

  if (!options.inputFile) {
    console.log(chalk.red("❌ Vui lòng cung cấp đường dẫn file backup cần giải mã!"));
    console.log(chalk.gray("Dùng --help để xem hướng dẫn"));
    process.exit(1);
  }

  const inputPath = path.resolve(options.inputFile);

  // Kiểm tra file tồn tại
  try {
    await fs.access(inputPath);
  } catch {
    console.log(chalk.red(`❌ Không tìm thấy file: ${inputPath}`));
    process.exit(1);
  }

  // Xác định thư mục đích
  const defaultOut = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, ".zip")}-decrypted`
  );
  const outputDir = path.resolve(options.outputDir || defaultOut);

  console.log(chalk.bold.blue("🔓 Giải mã file backup"));
  console.log(chalk.gray(`File input : ${inputPath}`));
  console.log(chalk.gray(`Thư mục đích: ${outputDir}`));

  // Lấy mật khẩu
  let password = options.password;

  if (!password) {
    const envKey = getEncryptionKey();
    if (envKey) {
      password = envKey;
      console.log(chalk.gray("🔑 Dùng mật khẩu từ BACKUP_ENCRYPTION_KEY trong .env"));
    } else {
      password = await askQuestion(chalk.yellow("🔑 Nhập mật khẩu: "));
      if (!password) {
        console.log(chalk.red("❌ Cần mật khẩu để giải mã!"));
        process.exit(1);
      }
    }
  }

  try {
    console.log(chalk.cyan("\n⏳ Đang giải mã..."));
    await decryptZipToDirectory(inputPath, outputDir, password);

    console.log(chalk.green(`\n✅ Giải mã thành công!`));
    console.log(chalk.gray(`📁 Thư mục kết quả: ${outputDir}`));
    console.log("");
    console.log(chalk.bold.yellow("Bước tiếp theo — import vào MongoDB:"));
    console.log(
      chalk.gray(`  node import-backup.cjs "${outputDir}" --all`)
    );
  } catch (error) {
    console.error(chalk.red(`\n❌ Giải mã thất bại: ${error.message}`));
    if (
      error.message.includes("authenticate") ||
      error.message.includes("Unsupported state")
    ) {
      console.error(
        chalk.yellow(
          "   → Sai mật khẩu, HOẶC file đã bị hỏng/tam đổi (tính toàn vẹn không khớp)."
        )
      );
    }
    process.exit(1);
  } finally {
    rl.close();
  }
}

main().catch(console.error);
