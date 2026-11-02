#!/bin/bash

SERVER="vps-prod"
DIR="/home/giakhang/www/backup"

echo "==> Creating remote directory..."
ssh $SERVER "mkdir -p $DIR"

echo "==> First sync source code..."
rsync -avz \
  --exclude node_modules \
  --exclude .git \
  --exclude backups \
  ./ $SERVER:$DIR

echo "==> Install dependencies + start app..."
ssh $SERVER "
cd $DIR &&
npm install &&
pm2 start scheduler.js --update-env
"

echo "==> First deploy completed"