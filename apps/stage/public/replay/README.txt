Drop the pre-recorded beat clips here as beat1.mp4 … beat6.mp4 (keys 1-6 on the stage play
them full screen, labelled REPLAY). They are not committed (large binaries).

They ship inside the server image: put them here before `fly deploy` and they are served at
https://<app>.fly.dev/stage/replay/beat{n}.mp4 (byte ranges, 5 min cache). The stage downloads
each clip once in the background, so a replay plays even when the network is the problem.

Encode for any browser and a fast start:
  ffmpeg -i in.mov -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 23 \
         -c:a aac -b:a 128k -movflags +faststart beat3.mp4
Keep each clip short (under ~30 MB) so the image and the background download stay small.
