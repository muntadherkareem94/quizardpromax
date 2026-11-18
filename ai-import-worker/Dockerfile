FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY worker.py .
COPY cost_guard.py .
COPY free_router.py .
COPY local_mcq.py .
COPY separated_key_mcq.py .
COPY paired_mcq.py .
COPY ai_source_context.py .
COPY ai_paired_worker.py .
COPY test_local_mcq.py .
COPY test_openai_budget.py .
COPY test_ai_source_context.py .
RUN python -m unittest -v test_local_mcq test_openai_budget test_ai_source_context
COPY server.py .
RUN python -m py_compile worker.py server.py local_mcq.py separated_key_mcq.py paired_mcq.py ai_source_context.py ai_paired_worker.py
ENV PYTHONUNBUFFERED=1
CMD ["python", "server.py"]
