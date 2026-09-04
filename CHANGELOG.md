# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release pull requests update this file as part of the reviewed release process.

## [Unreleased]

### Added

- `hookassert <subcommand> --help` (`explain`, `lint`, `record`, `test`) now prints that
  subcommand's own usage and options, instead of the identical global usage text every
  subcommand printed before. `hookassert --help` and a bare `hookassert` are unchanged.
