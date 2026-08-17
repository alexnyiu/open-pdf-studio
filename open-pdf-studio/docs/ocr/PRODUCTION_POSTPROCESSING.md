# Production OCR detection and layout post-processing

The macOS production adapter uses a bounded DB-style detector post-processing
path. It follows PaddleOCR's published DB pipeline: threshold the probability
map, extract connected contours, reject low-score or undersized candidates,
fit minimum-area quadrilaterals, unclip them, scale them to the actual source
raster, and suppress overlapping duplicates. The upstream references are
[DBPostProcess](https://github.com/PaddlePaddle/PaddleOCR/blob/main/ppocr/postprocess/db_postprocess.py)
and the [detector inference path](https://github.com/PaddlePaddle/PaddleOCR/blob/main/tools/infer/predict_det.py).

The production parameters are deliberately explicit:

- probability threshold: 0.3;
- box score threshold: 0.6;
- standard recognition-crop unclip ratio: 1.5;
- minimum connected region: 6 detector pixels;
- minimum detector-side length: 3 pixels;
- maximum detector candidates: 1,000;
- duplicate suppression: quadrilateral IoU of at least 0.85.

The standard unclipped, rotated quadrilateral is used to rectify the recognition
crop. The emitted line polygon keeps the same rotated axes and uses a
longitudinal support offset of 12 while retaining the standard transverse
offset of 1.5. This line-support normalization is applied uniformly, was fixed
before the accepted v2 benchmark run, and represents the searchable line region
rather than an axis-aligned glyph box. Axis-aligned bounding boxes are derived
from that quadrilateral only as conveniences.

There is no fixed 64-line cap. The candidate budget is the minimum of 1,000,
the production contract's line limit, the raster-area budget, and the result
budget after reserving 64 KiB and charging 4 KiB per possible line. More
contour extraction is also capped at 16,384 points per candidate and 262,144
points per page. More candidates, contour points, or more than 256 layout regions cause a typed
`OCR_PAGE_COMPLEXITY_LIMIT` failure. Recognition runs in batches of at most 32
lines so a dense page cannot create an unbounded recognition tensor.

Layout grouping is deterministic. Horizontally overlapping lines are joined
into an internal region; lines within a region are ordered top-to-bottom and
then left-to-right, while one or two regions are ordered left-to-right. The
frozen production result contract has ordered lines rather than block entities,
so these internal regions are flattened into the contract's line order.
Repeated three-column rows are marked `table`; more than two other regions are
marked `complex-layout`. Steep line rotation is marked `rotated-text`, and
recognition outside the benchmark-qualified text-density range is marked
`low-confidence`.

Automatic page orientation and deskew remain disabled because the approved
corpus does not qualify them. Mildly skewed text succeeds through rotated
detector quadrilateral rectification, not through page preprocessing. Every
result therefore records preprocessing status `none`, no operations, no output
raster, and no transform. Lines have an explicit unavailable engine baseline;
the adapter does not estimate one. It emits neither words, word polygons,
alternatives, language detection, nor writing direction, and the engine
descriptor keeps all corresponding capabilities false. The bundled model pack
continues to use automatic fixed-multilingual recognition without a language
selector.
