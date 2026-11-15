"""`python -m embedder` → serve §8.1 on $PORT (default 8090, EMBEDDER_URL default)."""
import os

import uvicorn

from .app import real_app

if __name__ == "__main__":
    uvicorn.run(real_app(), host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8090")))
