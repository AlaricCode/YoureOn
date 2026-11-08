import 'dart:convert';

import '../../api/models/huddle.dart';
import '../../capture/face_capture.dart';
import '../../capture/image_utils.dart';

/// One `{crop_b64, bbox}` per detected face (CONTRACTS.md §12.3
/// `POST /huddles/:id/scan`). A frame that can't be decoded locally sends
/// the whole frame as the crop.
List<FaceCrop> faceCrops(CapturedFrame frame) {
  final out = <FaceCrop>[];
  for (final f in frame.faces) {
    String b64;
    try {
      b64 = base64.encode(toUploadJpegSync(frame.jpeg, crop: f.bbox).jpeg);
    } catch (_) {
      b64 = base64.encode(frame.jpeg);
    }
    out.add(FaceCrop(cropB64: b64, bbox: f.bbox));
  }
  return out;
}
