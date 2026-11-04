import cron from 'node-cron';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Các script backup nằm cùng thư mục
// const backupScript = path.resolve(__dirname, 'backup.cjs');
const backupTelegramScript = path.resolve(__dirname, 'backup-telegram.cjs');
// const backupDriveScript = path.resolve(__dirname, 'backup-drive.cjs');

// Mỗi job có 1 cờ riêng để tránh chạy chồng nhau
const jobs = {
  // backup: { script: backupScript, running: false },
  telegram: { script: backupTelegramScript, running: false },
  // drive: { script: backupDriveScript, running: false },
};

function runJob(name) {
  const job = jobs[name];
  if (!job) return;

  if (job.running) {
    console.log(`[${name}] Job is already running. Skip...`);
    return;
  }
  job.running = true;

  console.log(`=== Start ${name} job ===`, new Date().toLocaleString());

  const child = spawn(process.execPath, [job.script, '--no-uploads'], {
    stdio: 'inherit',
  });

  child.on('close', (code) => {
    job.running = false;
    console.log(`=== ${name} job finished with code: ${code} ===`);
  });

  child.on('error', (err) => {
    job.running = false;
    console.error(`[${name}] Process error:`, err);
  });
}

// Backup local mỗi 6 giờ
// function runBackup() {
//   runJob('backup');
// }

// Backup + upload Telegram mỗi 12 giờ
function runBackupTelegram() {
  runJob('telegram');
}

// Backup + upload Google Drive mỗi 12 giờ
// function runBackupDrive() {
//   runJob('drive');
// }

// Chạy ngay khi start
// runBackup();

// Chạy mỗi 6 giờ
// cron.schedule('0 */6 * * *', runBackup);

// Backup lên Google Drive: 00:15 và 12:15 (chạy ngay khi start)
// cron.schedule('15 */12 * * *', runBackupDrive);
// runBackupDrive();

// Backup Telegram: 00:30 và 12:30
cron.schedule('30 */12 * * *', runBackupTelegram);
runBackupTelegram(); //Chạy ngay lần đầu