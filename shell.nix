let
  # use a specific (although arbitrarily chosen) version of the Nix package collection
  # https://github.com/NixOS/nixpkgs/tree/nixos-25.11 as of April 6, 2026
  pkgs = import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/36a601196c4ebf49e035270e10b2d103fe39076b.tar.gz";
    sha256 = "1vs1g86i75rgpsvs7kyqfv22j6x3sg3daf4cv6ws3d0ghkb2ggpz";
  }) { };

in
pkgs.mkShell {
  name = "sync-branches";

  buildInputs = [
    # node - v24.14.1
    # npm - 11.11.0
    pkgs.nodejs_24

    pkgs.nixfmt
  ];
}
