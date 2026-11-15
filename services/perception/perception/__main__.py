"""`python -m perception` → serve the §6.0 job API (uvicorn) on $PORT (default 8092)."""
import os

import uvicorn

from .app import real_app

if __name__ == "__main__":
    uvicorn.run(real_app(), host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8092")))
