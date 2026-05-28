"""
Build script for the donato_ext C++ addon.

Install with:
    pip install ./cpp_ext

This will:
  - read pybind11 headers/includes via pybind11.get_cmake_dir
  - compile haversine.cpp into a Python extension module called donato_ext
  - install it into the current Python environment so `import donato_ext` works
"""
from pybind11.setup_helpers import Pybind11Extension, build_ext
from setuptools import setup

ext_modules = [
    Pybind11Extension(
        "donato_ext",
        ["haversine.cpp"],
        cxx_std=17,
    ),
]

setup(
    name="donato_ext",
    version="0.1.0",
    description="C++ hot-path for Donato Smart Donor Matcher (Haversine batch)",
    ext_modules=ext_modules,
    cmdclass={"build_ext": build_ext},
    zip_safe=False,
)
