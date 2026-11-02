import cron from 'node-cron';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// backup.cjs cùng thư mục
const backupScript = path.resolve(__dirname, 'backup.cjs');
const backupTelegramScript = path.resolve(__dirname, 'backup-telegram.cjs');

let isRunning = false;

function runBackup() {
  if (isRunning) {
    console.log('Backup job is already running. Skip...');
    return;
  }

  isRunning = true;

  console.log('=== Start backup job ===', new Date().toLocaleString());

  const backup = spawn(process.execPath, [backupScript], {
    stdio: 'inherit',
  });

  backup.on('close', (code) => {
    isRunning = false;
    console.log(`=== Backup job finished with code: ${code} ===`);
  });

  backup.on('error', (err) => {
    isRunning = false;
    console.error('Backup process error:', err);
  });
}

// Chạy ngay khi start
runBackup();

// Chạy mỗi 1 giờ
cron.schedule('0 */6 * * *', runBackup);