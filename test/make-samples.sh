#!/bin/sh
# ساخت فایل‌های نمونه برای تست سرویس (نیاز به ffmpeg)
set -e
D=${1:-samples}; mkdir -p "$D"; cd "$D"
Q="-v error -y"
ffmpeg $Q -f lavfi -i testsrc2=s=3000x2000 -frames:v 1 big.png
ffmpeg $Q -f lavfi -i testsrc=s=100x100 -frames:v 1 small.jpg
ffmpeg $Q -f lavfi -i "color=c=red@0.5:s=300x300,format=rgba" -frames:v 1 alpha.png
ffmpeg $Q -f lavfi -i "nullsrc=s=1000x1000,format=gray,geq=random(1)*255,format=rgb24" -frames:v 1 noise.png
for t in 2 3 3.05 3.5 4 5; do
  ffmpeg $Q -f lavfi -i testsrc2=s=640x360:r=30 -t $t -pix_fmt yuv420p v_$t.mp4
done
ffmpeg $Q -f lavfi -i testsrc2=s=480x480:r=60 -t 3 -pix_fmt yuv420p v_60fps.mp4
ffmpeg $Q -f lavfi -i testsrc2=s=400x400:r=10 -t 2 g.gif
ffmpeg $Q -f lavfi -i "nullsrc=s=512x512:r=30,format=gray,geq=random(1)*255,format=yuv420p" -t 3 v_noise.mp4
ffmpeg $Q -f lavfi -i "color=c=blue@0.6:s=300x300:r=30,format=yuva420p" -t 2 -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 alpha.webm
head -c 2000 /dev/urandom > garbage.bin
printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:3,\n/etc/passwd\n#EXT-X-ENDLIST\n' > evil.m3u8
printf 'x%.0s' $(seq 1 50) | gzip > fake.tgs
