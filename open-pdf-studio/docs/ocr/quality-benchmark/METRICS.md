# OCR benchmark metrics v1

Text comparison applies Unicode NFKC normalization, locale-independent
lowercasing, whitespace collapse, and trim. Character error rate is Unicode
code-point Levenshtein distance divided by expected code points. Word error rate
uses the same distance over whitespace-delimited normalized words. Unexpected
text on an expected-empty page has an error rate of 1.

Line geometry is matched independently of recognized text. Expected and actual
convex polygons are paired greedily by descending intersection-over-union, with
a minimum IoU of 0.1 and at most one match per polygon. Precision is matched
lines divided by actual lines. Recall is matched lines divided by expected
lines. A correctly empty page receives precision and recall of 1.

Polygon overlap is reported both as intersection-over-union and as expected
polygon coverage, which is intersection area divided by expected area. Means
are calculated over matched lines. Expected polygons are deterministic fixture
quadrilaterals in `source-raster-pixels`; actual polygons come directly from the
validated engine result in that same space. Axis-aligned rectangles are not
substituted for the polygons.

Reading-order error is the normalized pair-inversion rate of geometrically
matched expected-line indexes in actual result order. An empty expected page and
zero or one matched line have no comparable pair and therefore an order error of 0. Missing expected lines
and unmatched actual lines are reported separately as missed and
duplicate/extra line counts rather than folded into the order score.

Unsupported-page accuracy is the fraction of unsupported fixtures for which the
engine itself returns an unsupported disposition. Fixture classification and
engine disposition remain separate, so an unsupported category never becomes a
passing production case merely because the engine returned text. Rejected-input
accuracy is the fraction of malformed or over-limit cases rejected with the
expected error class before model initialization.

Latency includes a cold model initialization for each raster and is recorded in
the machine-dependent timing file. PNG decode time is recorded separately and
excluded from page-recognition wall time. The accuracy baseline's peak result
size is the largest UTF-8 JSON serialization of a validated production result
after its timing metric values are canonically set to zero. The timing file also
records the full observed production-result size. This prevents millisecond
digit widths from changing the accuracy baseline while retaining the actual
protocol-size observation.
