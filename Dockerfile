# Lambda image with the local model baked in (too big for a zip, too slow to fetch per cold start).
# Local run and test: see README → Deploying to AWS.

FROM public.ecr.aws/lambda/nodejs:22

WORKDIR ${LAMBDA_TASK_ROOT}

# Lambda has no GPU and runs x86_64: keep only the CPU build of llama.cpp (~700 MB less).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && rm -rf node_modules/@node-llama-cpp/linux-x64-* node_modules/@node-llama-cpp/linux-arm*

# Only the downloader goes into this layer, so code changes don't re-download 1.1 GB.
COPY models.lock.json ./
COPY scripts/fetch-models.js scripts/
COPY app/config.js app/
COPY app/infrastructure/logger.js app/infrastructure/
COPY app/infrastructure/models app/infrastructure/models
ENV MODEL_CACHE_DIR=${LAMBDA_TASK_ROOT}/models
RUN node scripts/fetch-models.js

COPY app ./app

ENV MODEL_PROVIDER=local \
    LOCAL_MODELS_OFFLINE=true \
    LOG_LEVEL=INFO

CMD ["app/handler.handler"]
