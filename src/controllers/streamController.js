const path = require('path');
const db = require('../models/database');
const { startStream, isValidRtmpUrl } = require('../services/ffmpegService');
const logger = require('../utils/logger');

function startLiveStream(req, res) {
  const { videoId, settings, loop, customRtmp } = req.body;
  const parsedId = parseInt(videoId, 10);
  if (isNaN(parsedId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  const rtmpList = Array.isArray(customRtmp) ? customRtmp : [customRtmp];
  const validRtmps = rtmpList.filter(isValidRtmpUrl);
  if (validRtmps.length === 0) {
    return res.status(400).json({ error: 'At least one valid RTMP(S) URL is required' });
  }

  const safeSettings = {
    resolution: typeof settings?.resolution === 'string' ? settings.resolution : '1280x720',
    bitrate: typeof settings?.bitrate === 'string' ? settings.bitrate : '2500k',
    fps: typeof settings?.fps === 'string' || typeof settings?.fps === 'number' ? String(settings.fps) : '30'
  };

  db.get('SELECT filename FROM videos WHERE id = ?', [parsedId], (err, row) => {
    if (err || !row || !row.filename) {
      logger.error(`Stream error: ${err ? err.message : 'Video not found in DB'}`);
      return res.status(404).json({ error: 'Video not found in database' });
    }

    if (global.streamProcesses[parsedId]) {
      return res.status(400).json({ error: 'Stream is already running!' });
    }

    try {
      const uploadPath = path.resolve(process.env.UPLOAD_PATH || 'public/uploads');
      const videoPath = path.join(uploadPath, path.basename(row.filename));
      const proc = startStream(videoPath, safeSettings, Boolean(loop), validRtmps);

      if (!proc) {
        logger.error(`Failed to start FFmpeg for video ${parsedId}. Target missing or invalid: ${videoPath}`);
        return res.status(500).json({ error: 'Failed to start streaming process' });
      }

      global.streamProcesses[parsedId] = { pid: proc.pid, proc };
      db.run("UPDATE videos SET views = views + 1, destinations = ?, start_time = datetime('now', 'localtime'), resolution = ?, bitrate = ?, fps = ?, loop = ? WHERE id = ?",
        [JSON.stringify(validRtmps), safeSettings.resolution, safeSettings.bitrate, safeSettings.fps, loop ? 1 : 0, parsedId]);

      global.io.emit('streamStatus', { videoId: parsedId, pid: proc.pid, running: true, startTime: new Date() });
      res.json({ message: 'Streaming started!', pid: proc.pid });

    } catch (error) {
      logger.error(`Critical Stream Error: ${error.message}`);
      res.status(500).json({ error: 'Internal Server Error during start' });
    }
  });
}

function saveStreamConfig(req, res) {
  const { videoId, settings, loop, customRtmp } = req.body;

  db.run("UPDATE videos SET destinations = ?, resolution = ?, bitrate = ?, fps = ?, loop = ? WHERE id = ?",
    [JSON.stringify(customRtmp), settings.resolution, settings.bitrate, settings.fps, loop ? 1 : 0, videoId],
    function (err) {
      if (err) {
        logger.error(`Config save error: ${err.message}`);
        return res.status(500).json({ error: 'Failed to save config' });
      }
      res.json({ message: 'Configuration saved!' });
    }
  );
}

function stopLiveStream(req, res) {
  const { videoId } = req.body;

  if (!global.streamProcesses[videoId]) {
    db.run("UPDATE videos SET start_time = NULL WHERE id = ?", [videoId]);
    global.io.emit('streamStatus', { videoId, running: false });
    return res.json({ message: 'Stream already stopped' });
  }

  try {
    const processInfo = global.streamProcesses[videoId];
    if (processInfo && processInfo.proc) {
      processInfo.proc.kill('SIGKILL');
    }
    delete global.streamProcesses[videoId];
    db.run("UPDATE videos SET start_time = NULL WHERE id = ?", [videoId]);
    global.io.emit('streamStatus', { videoId, running: false });
    res.json({ message: 'Streaming stopped!' });
  } catch (e) {
    logger.error(`Error stopping stream: ${e.message}`);
    res.status(500).json({ error: 'Failed to stop stream' });
  }
}

module.exports = { startLiveStream, stopLiveStream, saveStreamConfig };