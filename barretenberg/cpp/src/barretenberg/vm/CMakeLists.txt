if(NOT DISABLE_AZTEC_VM)
  barretenberg_module(vm sumcheck stdlib_honk_verifier stdlib_goblin_verifier)
endif()
