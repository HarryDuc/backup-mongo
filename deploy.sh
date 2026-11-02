#!/bin/bash

SERVER="vps-prod"
DIR="/home/giakhang/www/backup"

rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude backups \
  ./ $SERVER:$DIR

ssh $SERVER "
cd $DIR &&
npm install &&
pm2 restart scheduler --update-env
"