#!/usr/bin/env sh
# Generates the test video, snapshots and self-signed certificate used by
# mock_frigate.py. Needs ffmpeg and openssl.
set -e
cd "$(dirname "$0")"
mkdir -p mock-media && cd mock-media

ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=30 -t 12 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart sample.mp4

# Fragmented MP4 with a keyframe every 12 frames, streamed as "live" MSE video.
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=25 -t 120 \
  -c:v libx264 -profile:v baseline -level 3.1 -pix_fmt yuv420p -g 12 -keyint_min 12 -sc_threshold 0 \
  -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 live_frag.mp4

for cam in doorbell pool north_outside garage; do
  ffmpeg -loglevel error -y -f lavfi -i testsrc=size=1280x720:rate=1 -frames:v 1 "$cam.jpg"
done
ffmpeg -loglevel error -y -i pool.jpg -vf scale=320:-1 thumb.jpg

openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=frigate.test" 2>/dev/null

# 30 minutes of "recording" as HLS with fMP4 segments, like Frigate's /vod/.
# The burned-in clock is media time, handy for checking seeks.
mkdir -p vod && cd vod
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=5" -t 1800 \
  -vf "drawtext=text='%{pts\:hms}':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.7:x=20:y=20" \
  -c:v libx264 -preset ultrafast -profile:v main -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 \
  -f hls -hls_time 10 -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "seg-%d.m4s" -hls_playlist_type vod index.m3u8
cd ..
echo "mock media ready in $(pwd)"
