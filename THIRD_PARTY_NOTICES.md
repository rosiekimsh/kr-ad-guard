# 제3자 구성요소 고지

이 확장은 `extension/lib/` 에 아래 오픈소스를 **수정 없이** 포함합니다. 모두 Apache License 2.0 입니다 (전문: `licenses/Apache-2.0.txt`).

| 구성요소 | 용도 | 라이선스 | 출처 |
|---|---|---|---|
| Tesseract.js (`tesseract.min.js`, `worker.min.js`) | 브라우저 안 OCR 실행 | Apache-2.0 | https://github.com/naptha/tesseract.js |
| Tesseract.js Core (`lib/core/*.wasm.js`) | OCR 엔진(WebAssembly) | Apache-2.0 | https://github.com/naptha/tesseract.js-core |
| Tesseract OCR 한국어 학습 데이터 (`lib/lang/kor.traineddata.gz`, `best_int`) | 한국어 글자 인식 모델 | Apache-2.0 | https://github.com/tesseract-ocr/tessdata_best (npm: `@tesseract.js-data/kor`) |
| Tesseract OCR | 위 모델의 원 프로젝트 | Apache-2.0 | https://github.com/tesseract-ocr/tesseract |

각 번들 파일 상단의 `LICENSE.txt` 안내는 원 프로젝트의 빌드 산출물 표기이며, 라이선스 전문은 `licenses/Apache-2.0.txt` 를 참고하세요.
