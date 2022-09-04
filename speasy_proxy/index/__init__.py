from ..config import index as index_cfg
from diskcache import Index

index = Index(index_cfg.path())
