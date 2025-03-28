#include "barretenberg/numeric/uint256/uint256.hpp"
#include "barretenberg/vm/avm/tests/helpers.test.hpp"
#include "barretenberg/vm/avm/trace/common.hpp"
#include "barretenberg/vm/avm/trace/public_inputs.hpp"
#include "common.test.hpp"
#include <gmock/gmock.h>
#include <gtest/gtest.h>

#define ALU_ROW_FIELD_EQ(field_name, expression) Field(#field_name, &Row::alu_##field_name, expression)

namespace tests_avm {

using namespace bb;
using namespace bb::avm_trace;
using namespace testing;

class AvmCastTests : public ::testing::Test {
  public:
    AvmCastTests()
        : public_inputs(generate_base_public_inputs())
        , trace_builder(
              AvmTraceBuilder(public_inputs).set_full_precomputed_tables(false).set_range_check_required(false))
    {
        srs::init_crs_factory(bb::srs::get_ignition_crs_path());
    }

    AvmPublicInputs public_inputs;
    AvmTraceBuilder trace_builder;
    std::vector<FF> calldata;

    std::vector<Row> trace;
    size_t main_row_idx;
    size_t alu_row_idx;
    size_t mem_c_row_idx;

    void gen_trace(
        uint128_t const& a, uint32_t src_address, uint32_t dst_address, AvmMemoryTag src_tag, AvmMemoryTag dst_tag)
    {
        trace_builder.op_set(0, uint256_t::from_uint128(a), src_address, src_tag);
        trace_builder.op_cast(0, src_address, dst_address, dst_tag);
        trace_builder.op_set(0, 0, 100, AvmMemoryTag::U32);
        trace_builder.op_return(0, 0, 100);
        trace = trace_builder.finalize();
        gen_indices();
    }

    void gen_indices()
    {
        auto row = std::ranges::find_if(trace.begin(), trace.end(), [](Row r) { return r.main_sel_op_cast == FF(1); });
        ASSERT_TRUE(row != trace.end());
        main_row_idx = static_cast<size_t>(row - trace.begin());

        // Find the corresponding Alu trace row
        auto clk = row->main_clk;
        auto alu_row = std::ranges::find_if(trace.begin(), trace.end(), [clk](Row r) { return r.alu_clk == clk; });
        ASSERT_TRUE(alu_row != trace.end());
        alu_row_idx = static_cast<size_t>(alu_row - trace.begin());

        // Mem entry output ic write operation
        auto mem_row_c = std::ranges::find_if(trace.begin(), trace.end(), [clk](Row r) {
            return r.mem_tsp == FF(AvmMemTraceBuilder::NUM_SUB_CLK) * clk + AvmMemTraceBuilder::SUB_CLK_STORE_C;
        });
        ASSERT_TRUE(mem_row_c != trace.end());
        mem_c_row_idx = static_cast<size_t>(mem_row_c - trace.begin());
    }

    void validate_cast_trace(FF const& a,
                             FF const& cast_val,
                             uint32_t src_address,
                             uint32_t dst_address,
                             AvmMemoryTag src_tag,
                             AvmMemoryTag dst_tag)
    {
        auto const& row = trace.at(main_row_idx);
        EXPECT_THAT(row,
                    AllOf(MAIN_ROW_FIELD_EQ(sel_op_cast, 1),
                          MAIN_ROW_FIELD_EQ(ia, a),
                          MAIN_ROW_FIELD_EQ(ib, 0),
                          MAIN_ROW_FIELD_EQ(ic, cast_val),
                          MAIN_ROW_FIELD_EQ(r_in_tag, static_cast<uint32_t>(src_tag)),
                          MAIN_ROW_FIELD_EQ(w_in_tag, static_cast<uint32_t>(dst_tag)),
                          MAIN_ROW_FIELD_EQ(alu_in_tag, static_cast<uint32_t>(dst_tag)),
                          MAIN_ROW_FIELD_EQ(sel_mem_op_a, 1),
                          MAIN_ROW_FIELD_EQ(sel_mem_op_c, 1),
                          MAIN_ROW_FIELD_EQ(rwa, 0),
                          MAIN_ROW_FIELD_EQ(rwc, 1),
                          MAIN_ROW_FIELD_EQ(mem_addr_a, src_address),
                          MAIN_ROW_FIELD_EQ(mem_addr_c, dst_address),
                          MAIN_ROW_FIELD_EQ(tag_err, 0),
                          MAIN_ROW_FIELD_EQ(sel_alu, 1),
                          MAIN_ROW_FIELD_EQ(sel_rng_8, 1),
                          MAIN_ROW_FIELD_EQ(sel_rng_16, 1)));

        auto const& alu_row = trace.at(alu_row_idx);
        EXPECT_THAT(alu_row,
                    AllOf(ALU_ROW_FIELD_EQ(op_cast, 1),
                          ALU_ROW_FIELD_EQ(ia, a),
                          ALU_ROW_FIELD_EQ(ib, 0),
                          ALU_ROW_FIELD_EQ(ic, cast_val),
                          ALU_ROW_FIELD_EQ(u8_tag, dst_tag == AvmMemoryTag::U8),
                          ALU_ROW_FIELD_EQ(u16_tag, dst_tag == AvmMemoryTag::U16),
                          ALU_ROW_FIELD_EQ(u32_tag, dst_tag == AvmMemoryTag::U32),
                          ALU_ROW_FIELD_EQ(u64_tag, dst_tag == AvmMemoryTag::U64),
                          ALU_ROW_FIELD_EQ(u128_tag, dst_tag == AvmMemoryTag::U128),
                          ALU_ROW_FIELD_EQ(ff_tag, dst_tag == AvmMemoryTag::FF),
                          ALU_ROW_FIELD_EQ(in_tag, static_cast<uint32_t>(dst_tag)),
                          ALU_ROW_FIELD_EQ(sel_alu, 1)));

        validate_trace(std::move(trace), public_inputs, calldata);
    }
};

class AvmCastNegativeTests : public AvmCastTests {
  protected:
    void SetUp() override { GTEST_SKIP(); }
};

TEST_F(AvmCastTests, basicU1ToU8)
{
    gen_trace(1, 0, 1, AvmMemoryTag::U1, AvmMemoryTag::U8);
    validate_cast_trace(1, 1, 0, 1, AvmMemoryTag::U1, AvmMemoryTag::U8);
}

TEST_F(AvmCastTests, noTruncationU8ToU1)
{
    gen_trace(1, 0, 1, AvmMemoryTag::U8, AvmMemoryTag::U1);
    validate_cast_trace(1, 1, 0, 1, AvmMemoryTag::U8, AvmMemoryTag::U1);
}

TEST_F(AvmCastTests, truncationU8ToU1)
{
    gen_trace(15, 0, 1, AvmMemoryTag::U8, AvmMemoryTag::U1);
    validate_cast_trace(15, 1, 0, 1, AvmMemoryTag::U8, AvmMemoryTag::U1);
}

TEST_F(AvmCastTests, basicU8ToU16)
{
    gen_trace(237, 0, 1, AvmMemoryTag::U8, AvmMemoryTag::U16);
    validate_cast_trace(237, 237, 0, 1, AvmMemoryTag::U8, AvmMemoryTag::U16);
}

TEST_F(AvmCastTests, truncationU32ToU8)
{
    gen_trace(876123, 0, 1, AvmMemoryTag::U32, AvmMemoryTag::U8);
    validate_cast_trace(876123, 91, 0, 1, AvmMemoryTag::U32, AvmMemoryTag::U8);
}

TEST_F(AvmCastTests, sameAddressU16ToU8)
{
    gen_trace(1049, 23, 23, AvmMemoryTag::U16, AvmMemoryTag::U8); // M[23] = 1049
    validate_cast_trace(1049, 25, 23, 23, AvmMemoryTag::U16, AvmMemoryTag::U8);
}

TEST_F(AvmCastTests, basicU64ToFF)
{
    gen_trace(987234987324233324UL, 0, 1, AvmMemoryTag::U64, AvmMemoryTag::FF);
    validate_cast_trace(987234987324233324UL, 987234987324233324UL, 0, 1, AvmMemoryTag::U64, AvmMemoryTag::FF);
}

TEST_F(AvmCastTests, sameTagU128)
{
    uint128_t a = 312;
    a = a << 99;
    gen_trace(a, 0, 1, AvmMemoryTag::U128, AvmMemoryTag::U128);
    validate_cast_trace(
        uint256_t::from_uint128(a), FF(uint256_t::from_uint128(a)), 0, 1, AvmMemoryTag::U128, AvmMemoryTag::U128);
}

TEST_F(AvmCastTests, U128toFFWithBorrow)
{
    uint128_t const a = (uint128_t{ 0x30644E72E131A029LLU } << 64) + uint128_t{ 0xB85045B68181585DLLU };
    gen_trace(a, 0, 1, AvmMemoryTag::U128, AvmMemoryTag::FF);
    validate_cast_trace(
        uint256_t::from_uint128(a), FF(uint256_t::from_uint128(a)), 0, 1, AvmMemoryTag::U128, AvmMemoryTag::FF);
}

TEST_F(AvmCastTests, noTruncationFFToU32)
{
    gen_trace(UINT32_MAX, 4, 9, AvmMemoryTag::FF, AvmMemoryTag::U32);
    validate_cast_trace(UINT32_MAX, UINT32_MAX, 4, 9, AvmMemoryTag::FF, AvmMemoryTag::U32);
}

TEST_F(AvmCastTests, truncationFFToU16ModMinus1)
{
    calldata = { FF::modulus - 1 };
    trace_builder =
        AvmTraceBuilder(public_inputs, {}, 0).set_full_precomputed_tables(false).set_range_check_required(false);
    trace_builder.set_all_calldata(calldata);
    AvmTraceBuilder::ExtCallCtx ext_call_ctx({ .context_id = 0,
                                               .parent_id = 0,
                                               .is_top_level = true,
                                               .contract_address = FF(0),
                                               .calldata = calldata,
                                               .nested_returndata = {},
                                               .last_pc = 0,
                                               .success_offset = 0,
                                               .start_l2_gas_left = 0,
                                               .start_da_gas_left = 0,
                                               .l2_gas_left = 0,
                                               .da_gas_left = 0,
                                               .internal_return_ptr_stack = {} });
    trace_builder.current_ext_call_ctx = ext_call_ctx;
    trace_builder.op_set(0, 0, 0, AvmMemoryTag::U32);
    trace_builder.op_set(0, 1, 1, AvmMemoryTag::U32);
    trace_builder.op_calldata_copy(0, 0, 1, 0);
    trace_builder.op_cast(0, 0, 1, AvmMemoryTag::U16);
    trace_builder.op_set(0, 0, 100, AvmMemoryTag::U32);
    trace_builder.op_return(0, 0, 100);
    trace = trace_builder.finalize();
    gen_indices();

    validate_cast_trace(FF::modulus - 1, 0, 0, 1, AvmMemoryTag::FF, AvmMemoryTag::U16);
}

TEST_F(AvmCastTests, truncationFFToU16ModMinus2)
{
    calldata = { FF::modulus_minus_two };
    trace_builder =
        AvmTraceBuilder(public_inputs, {}, 0).set_full_precomputed_tables(false).set_range_check_required(false);
    trace_builder.set_all_calldata(calldata);
    AvmTraceBuilder::ExtCallCtx ext_call_ctx({ .context_id = 0,
                                               .parent_id = 0,
                                               .is_top_level = true,
                                               .contract_address = FF(0),
                                               .calldata = calldata,
                                               .nested_returndata = {},
                                               .last_pc = 0,
                                               .success_offset = 0,
                                               .start_l2_gas_left = 0,
                                               .start_da_gas_left = 0,
                                               .l2_gas_left = 0,
                                               .da_gas_left = 0,
                                               .internal_return_ptr_stack = {} });
    trace_builder.current_ext_call_ctx = ext_call_ctx;

    trace_builder.op_set(0, 0, 0, AvmMemoryTag::U32);
    trace_builder.op_set(0, 1, 1, AvmMemoryTag::U32);
    trace_builder.op_calldata_copy(0, 0, 1, 0);
    trace_builder.op_cast(0, 0, 1, AvmMemoryTag::U16);
    trace_builder.op_set(0, 0, 100, AvmMemoryTag::U32);
    trace_builder.op_return(0, 0, 100);
    trace = trace_builder.finalize();
    gen_indices();

    validate_cast_trace(FF::modulus_minus_two, UINT16_MAX, 0, 1, AvmMemoryTag::FF, AvmMemoryTag::U16);
}

TEST_F(AvmCastTests, truncationU32ToU16)
{
    // 998877665 = OX3B89A9E1
    // Truncated to 16 bits: 0XA9E1 = 43489
    gen_trace(998877665UL, 0, 1, AvmMemoryTag::U32, AvmMemoryTag::U16);
    validate_cast_trace(998877665UL, 43489, 0, 1, AvmMemoryTag::U32, AvmMemoryTag::U16);
}

TEST_F(AvmCastTests, indirectAddrTruncationU64ToU8)
{
    // Indirect addresses. src:0  dst:1
    // Direct addresses.   src:10 dst:11
    // Source value: 256'000'000'203 --> truncated to 203
    trace_builder.op_set(0, 10, 0, AvmMemoryTag::U32);
    trace_builder.op_set(0, 11, 1, AvmMemoryTag::U32);
    trace_builder.op_set(0, 256'000'000'203UL, 10, AvmMemoryTag::U64);
    trace_builder.op_cast(3, 0, 1, AvmMemoryTag::U8);
    trace_builder.op_set(0, 0, 100, AvmMemoryTag::U32);
    trace_builder.op_return(0, 0, 100);
    trace = trace_builder.finalize();
    gen_indices();

    validate_cast_trace(256'000'000'203UL, 203, 10, 11, AvmMemoryTag::U64, AvmMemoryTag::U8);
}

TEST_F(AvmCastTests, indirectAddrWrongResolutionU64ToU8)
{
    // TODO(#9995): Re-enable as part of #9995
    GTEST_SKIP();
    // Indirect addresses. src:5  dst:6
    // Direct addresses.   src:10 dst:11
    trace_builder.op_set(0, 10, 5, AvmMemoryTag::U8); // Not an address type
    trace_builder.op_set(0, 11, 6, AvmMemoryTag::U32);
    trace_builder.op_set(0, 4234, 10, AvmMemoryTag::U64);
    trace_builder.op_cast(3, 5, 6, AvmMemoryTag::U8);
    trace_builder.op_set(0, 0, 100, AvmMemoryTag::U32);
    trace_builder.op_return(0, 0, 100);
    trace = trace_builder.finalize();

    auto row = std::ranges::find_if(trace.begin(), trace.end(), [](Row r) { return r.main_sel_op_cast == FF(1); });
    ASSERT_TRUE(row != trace.end());

    EXPECT_THAT(*row,
                AllOf(MAIN_ROW_FIELD_EQ(sel_op_cast, 1),
                      MAIN_ROW_FIELD_EQ(r_in_tag, static_cast<uint32_t>(AvmMemoryTag::U64)),
                      MAIN_ROW_FIELD_EQ(w_in_tag, static_cast<uint32_t>(AvmMemoryTag::U8)),
                      MAIN_ROW_FIELD_EQ(alu_in_tag, static_cast<uint32_t>(AvmMemoryTag::U8)),
                      MAIN_ROW_FIELD_EQ(sel_mem_op_a, 1),
                      MAIN_ROW_FIELD_EQ(sel_mem_op_c, 1),
                      MAIN_ROW_FIELD_EQ(sel_resolve_ind_addr_a, 1),
                      MAIN_ROW_FIELD_EQ(sel_resolve_ind_addr_c, 1),
                      MAIN_ROW_FIELD_EQ(ind_addr_a, 5),
                      MAIN_ROW_FIELD_EQ(ind_addr_c, 6),
                      MAIN_ROW_FIELD_EQ(rwa, 0),
                      MAIN_ROW_FIELD_EQ(rwc, 1),
                      MAIN_ROW_FIELD_EQ(sel_alu, 0),   // ALU trace not activated
                      MAIN_ROW_FIELD_EQ(tag_err, 1))); // Error activated

    validate_trace(std::move(trace), public_inputs);
}

TEST_F(AvmCastNegativeTests, nonTruncatedOutputMainIc)
{
    gen_trace(300, 0, 1, AvmMemoryTag::U16, AvmMemoryTag::U8);
    ASSERT_EQ(trace.at(main_row_idx).main_ic, 44);

    // Replace the output in main trace with the non-truncated value
    trace.at(main_row_idx).main_ic = 300;

    // Adapt the memory trace entry
    trace.at(mem_c_row_idx).mem_val = 300;

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "PERM_MAIN_ALU");
}

TEST_F(AvmCastNegativeTests, wrongOutputMainIc)
{
    gen_trace(151515, 0, 1, AvmMemoryTag::U32, AvmMemoryTag::FF);
    ASSERT_EQ(trace.at(main_row_idx).main_ic, 151515);

    // Replace the output in main trace with a wrong value
    trace.at(main_row_idx).main_ic = 151516;

    // Adapt the memory trace entry
    trace.at(mem_c_row_idx).mem_val = 151516;

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "PERM_MAIN_ALU");
}

TEST_F(AvmCastNegativeTests, wrongOutputAluIc)
{
    gen_trace(6582736, 0, 1, AvmMemoryTag::U128, AvmMemoryTag::U16);
    ASSERT_EQ(trace.at(alu_row_idx).alu_ic, 29136);

    // Replace output in ALU, MAIN, and MEM trace
    trace.at(alu_row_idx).alu_ic = 33;
    trace.at(main_row_idx).main_ic = 33;
    trace.at(mem_c_row_idx).mem_val = 33;

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "ALU_OP_CAST");
}

TEST_F(AvmCastNegativeTests, wrongLimbDecompositionInput)
{
    calldata = { FF::modulus_minus_two };
    trace_builder =
        AvmTraceBuilder(public_inputs, {}, 0).set_full_precomputed_tables(false).set_range_check_required(false);
    trace_builder.op_calldata_copy(0, 0, 1, 0);
    trace_builder.op_cast(0, 0, 1, AvmMemoryTag::U16);
    trace_builder.op_set(0, 0, 100, AvmMemoryTag::U32);
    trace_builder.op_return(0, 0, 100);
    trace = trace_builder.finalize();
    gen_indices();

    trace.at(alu_row_idx).alu_a_lo -= 23;

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "INPUT_DECOMP_1");
}

TEST_F(AvmCastNegativeTests, wrongPSubALo)
{
    gen_trace(12345, 0, 1, AvmMemoryTag::U32, AvmMemoryTag::U16);
    ASSERT_EQ(trace.at(alu_row_idx).alu_ic, 12345);

    // trace.at(alu_row_idx).alu_p_sub_a_lo += 3;

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "SUB_LO_1");
}

TEST_F(AvmCastNegativeTests, wrongPSubAHi)
{
    calldata = { FF::modulus_minus_two - 987 };
    trace_builder =
        AvmTraceBuilder(public_inputs, {}, 0).set_full_precomputed_tables(false).set_range_check_required(false);
    trace_builder.op_calldata_copy(0, 0, 1, 0);
    trace_builder.op_cast(0, 0, 1, AvmMemoryTag::U16);
    trace_builder.op_set(0, 0, 100, AvmMemoryTag::U32);
    trace_builder.op_return(0, 0, 100);
    trace = trace_builder.finalize();
    gen_indices();

    // trace.at(alu_row_idx).alu_p_sub_a_hi += 3;

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "SUB_HI_1");
}

TEST_F(AvmCastNegativeTests, disableRangecheck)
{
    gen_trace(123, 23, 43, AvmMemoryTag::U8, AvmMemoryTag::U8);

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "RNG_CHK_LOOKUP_SELECTOR");
}

TEST_F(AvmCastNegativeTests, disableRangecheckSub)
{
    gen_trace(123, 23, 43, AvmMemoryTag::U8, AvmMemoryTag::U8);

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "RNG_CHK_LOOKUP_SELECTOR");
}

TEST_F(AvmCastNegativeTests, wrongRangeCheckDecompositionLo)
{
    gen_trace(987344323, 23, 43, AvmMemoryTag::FF, AvmMemoryTag::U128);
    ASSERT_EQ(trace.at(alu_row_idx).alu_ic, 987344323);

    // trace.at(alu_row_idx).alu_u16_r0 = 5555;
    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "LOWER_CMP_RNG_CHK");
}

TEST_F(AvmCastNegativeTests, wrongRangeCheckDecompositionHi)
{
    calldata = { FF::modulus_minus_two - 987 };
    trace_builder =
        AvmTraceBuilder(public_inputs, {}, 0).set_full_precomputed_tables(false).set_range_check_required(false);
    trace_builder.op_calldata_copy(0, 0, 1, 0);
    trace_builder.op_cast(0, 0, 1, AvmMemoryTag::U16);
    trace_builder.op_set(0, 0, 100, AvmMemoryTag::U32);
    trace_builder.op_return(0, 0, 100);
    trace = trace_builder.finalize();
    gen_indices();

    // trace.at(alu_row_idx).alu_u16_r9 = 5555;
    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "UPPER_CMP_RNG_CHK");
}

TEST_F(AvmCastNegativeTests, outOfRangeU8Registers)
{
    gen_trace(987344323, 23, 43, AvmMemoryTag::FF, AvmMemoryTag::U128);
    ASSERT_EQ(trace.at(alu_row_idx).alu_ic, 987344323);

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "Lookup LOOKUP_U8_0");
}

TEST_F(AvmCastNegativeTests, outOfRangeU16Registers)
{
    gen_trace(987344323, 23, 43, AvmMemoryTag::FF, AvmMemoryTag::U128);
    ASSERT_EQ(trace.at(alu_row_idx).alu_ic, 987344323);

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "Lookup LOOKUP_U16_0");
}

TEST_F(AvmCastNegativeTests, wrongCopySubLoForRangeCheck)
{
    gen_trace(987344323, 23, 43, AvmMemoryTag::U64, AvmMemoryTag::U128);
    ASSERT_EQ(trace.at(alu_row_idx).alu_ic, 987344323);

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "OP_CAST_RNG_CHECK_P_SUB_A_LOW");
}

TEST_F(AvmCastNegativeTests, wrongCopySubHiForRangeCheck)
{
    std::vector<FF> const calldata = { FF::modulus_minus_two - 972836 };
    trace_builder =
        AvmTraceBuilder(public_inputs, {}, 0).set_full_precomputed_tables(false).set_range_check_required(false);
    trace_builder.op_calldata_copy(0, 0, 1, 0);
    trace_builder.op_cast(0, 0, 1, AvmMemoryTag::U128);
    trace_builder.op_set(0, 0, 100, AvmMemoryTag::U32);
    trace_builder.op_return(0, 0, 100);
    trace = trace_builder.finalize();
    gen_indices();

    EXPECT_THROW_WITH_MESSAGE(validate_trace_check_circuit(std::move(trace)), "OP_CAST_RNG_CHECK_P_SUB_A_HIGH");
}

} // namespace tests_avm
