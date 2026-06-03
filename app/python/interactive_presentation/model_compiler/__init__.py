from .interfaces import PresentationModelCompiler

__all__ = ["DefaultPresentationModelCompiler", "PresentationModelCompiler"]


def __getattr__(name: str):
  if name == "DefaultPresentationModelCompiler":
    from .service import DefaultPresentationModelCompiler

    return DefaultPresentationModelCompiler
  raise AttributeError(name)
