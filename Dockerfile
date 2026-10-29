# Agula Terminal container: used by Cloudflare Containers, and by any Docker host.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AGULA_CACHE_DIR=/tmp/agula-cache \
    NO_BROWSER=1 \
    PORT=8080

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agula.py .
RUN useradd --create-home agula
USER agula

EXPOSE 8080
# One worker on purpose: every visitor shares one in-memory cache.
CMD ["sh", "-c", "exec uvicorn agula:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
