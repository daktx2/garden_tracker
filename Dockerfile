FROM python:3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY app/ /app/

RUN adduser -D -u 1000 garden && mkdir -p /data && chown garden:garden /data
USER garden

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,os; urllib.request.urlopen('http://127.0.0.1:%s/api/crops' % os.environ.get('PORT','8080'), timeout=4)" || exit 1

CMD ["python", "server.py"]
