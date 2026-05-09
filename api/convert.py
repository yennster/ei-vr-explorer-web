# Vercel Python serverless function that converts a raw TFLite flatbuffer
# (sent as the request body) into an ONNX model and streams the bytes back.
#
# We use tflite2onnx because it parses the TFLite flatbuffer directly and
# does not pull in TensorFlow — keeping the function bundle small enough to
# fit comfortably under Vercel's 500 MB Python bundle limit.

from http.server import BaseHTTPRequestHandler
import os
import tempfile


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0') or '0')
        except ValueError:
            length = 0
        if length <= 0:
            self._send_error(400, "Empty body — send TFLite bytes as the request body")
            return

        tflite_bytes = self.rfile.read(length)
        try:
            onnx_bytes = self._convert(tflite_bytes)
        except Exception as e:  # noqa: BLE001
            self._send_error(500, f"Conversion failed: {type(e).__name__}: {e}")
            return

        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(onnx_bytes)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(onnx_bytes)

    def do_GET(self):
        # Health probe so the page can sanity-check the function is alive.
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok":true,"endpoint":"convert","accepts":"POST raw TFLite bytes"}')

    def _send_error(self, status: int, message: str):
        body = (f'{{"error": {message!r}}}').encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _convert(tflite_bytes: bytes) -> bytes:
        import tflite2onnx  # imported lazily so the module load is fast
        with tempfile.TemporaryDirectory() as tmp:
            tflite_path = os.path.join(tmp, "model.tflite")
            onnx_path = os.path.join(tmp, "model.onnx")
            with open(tflite_path, "wb") as f:
                f.write(tflite_bytes)
            tflite2onnx.convert(tflite_path, onnx_path)
            with open(onnx_path, "rb") as f:
                return f.read()
