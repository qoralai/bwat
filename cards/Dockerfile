# syntax=docker/dockerfile:1
# bwat-cards. Build from cards/: `docker build -t bwat-cards cards`.
# One process: the stored transcript read, the card writer and the card API on 8000.

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY __main__.py service.py ./
COPY api ./api
COPY capture ./capture
COPY writer ./writer
# The CA for Postgres on RDS: BWAT_DB_SSLROOTCERT=/app/rds-global-bundle.pem, as the backend.
# Pinned: when AWS changes the bundle the build fails here, and the digest is updated.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
USER nobody
EXPOSE 8000
CMD ["python", "."]
