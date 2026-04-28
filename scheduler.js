import cron from 'node-cron';
import { spawn } from 'child_process';

function runBackup() {
  console.log('=== Start backup job ===', new Date().toLocaleString());

  const backup = spawn('node', ['C:/Project/backup/backup.cjs'], {
    shell: true,
    stdio: 'inherit',
  });

  backup.on('close', (code) => {
    console.log(`=== Backup job finished with code: ${code} ===`);
  });
  backup.on('error', (err) => {
    console.error('Backup process error:', err);
  });
}

runBackup();

// ch?y l?i m?i 6h
cron.schedule('0 */1 * * *', runBackup);
