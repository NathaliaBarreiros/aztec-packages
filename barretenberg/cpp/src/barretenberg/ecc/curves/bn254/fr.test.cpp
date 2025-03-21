#include "fr.hpp"
#include "barretenberg/serialize/test_helper.hpp"
#include <gtest/gtest.h>

using namespace bb;

TEST(fr, Msgpack)
{
    auto [actual, expected] = msgpack_roundtrip(bb::fr{ 1ULL, 2ULL, 3ULL, 4ULL });
    EXPECT_EQ(actual, expected);
}

TEST(fr, Eq)
{
    fr a{ 0x01, 0x02, 0x03, 0x04 };
    fr b{ 0x01, 0x02, 0x03, 0x04 };
    fr c{ 0x01, 0x02, 0x03, 0x05 };
    fr d{ 0x01, 0x02, 0x04, 0x04 };
    fr e{ 0x01, 0x03, 0x03, 0x04 };
    fr f{ 0x02, 0x02, 0x03, 0x04 };
    EXPECT_EQ((a == b), true);
    EXPECT_EQ((a == c), false);
    EXPECT_EQ((a == d), false);
    EXPECT_EQ((a == e), false);
    EXPECT_EQ((a == f), false);
}

TEST(fr, IsZero)
{
    fr a = fr::zero();
    fr b = fr::zero();
    fr c = fr::zero();
    fr d = fr::zero();
    fr e = fr::zero();

    b.data[0] = 1;
    c.data[1] = 1;
    d.data[2] = 1;
    e.data[3] = 1;
    EXPECT_EQ(a.is_zero(), true);
    EXPECT_EQ(b.is_zero(), false);
    EXPECT_EQ(c.is_zero(), false);
    EXPECT_EQ(d.is_zero(), false);
    EXPECT_EQ(e.is_zero(), false);
}

TEST(fr, RandomElement)
{
    fr a = fr::random_element();
    fr b = fr::random_element();

    EXPECT_EQ((a == b), false);
    EXPECT_EQ(a.is_zero(), false);
    EXPECT_EQ(b.is_zero(), false);
}

TEST(fr, Mul)
{
    auto a_uint = uint256_t{ 0x192f9ddc938ea63, 0x1db93d61007ec4fe, 0xc89284ec31fa49c0, 0x2478d0ff12b04f0f };
    auto b_uint = uint256_t{ 0x7aade4892631231c, 0x8e7515681fe70144, 0x98edb76e689b6fd8, 0x5d0886b15fc835fa };

    fr a = a_uint;
    fr b = b_uint;
    fr expected = (uint512_t(a_uint) * uint512_t(b_uint) % uint512_t(fr::modulus)).lo;
    fr result;
    result = a * b;
    EXPECT_EQ((result == expected), true);
}

TEST(fr, Sqr)
{
    auto a_uint = uint256_t{ 0x192f9ddc938ea63, 0x1db93d61007ec4fe, 0xc89284ec31fa49c0, 0x2478d0ff12b04f0f };
    fr a = a_uint;
    fr expected = (uint512_t(a_uint) * uint512_t(a_uint) % uint512_t(fr::modulus)).lo;
    fr result;
    result = a.sqr();
    EXPECT_EQ((result == expected), true);
}

TEST(fr, Add)
{
    fr a{ 0x20565a572c565a66, 0x7bccd0f01f5f7bff, 0x63ec2beaad64711f, 0x624953caaf44a814 };
    fr b{ 0xa17307a2108adeea, 0x74629976c14c5e2b, 0x9ce6f072ab1740ee, 0x398c753702b2bef0 };
    fr expected{ 0x7de76c654ce1394f, 0xc7fb821e66f26999, 0x4882d6a6d6fa59b0, 0x6b717a8ed0c5c6db };
    fr result;
    result = a + b;
    EXPECT_EQ(result, expected.reduce_once());
}

TEST(fr, Sub)
{
    fr a{ 0xcfbcfcf457cf2d38, 0x7b27af26ce62aa61, 0xf0378e90d48f2b92, 0x4734b22cb21ded };
    fr b{ 0x569fdb1db5198770, 0x446ddccef8347d52, 0xef215227182d22a, 0x8281b4fb109306 };
    fr expected{ 0xbcff176a92b5a5c9, 0x5eedbaa04fe79da0, 0x9995bf24e48db1c5, 0x3029017012d32b11 };
    fr result;
    result = a - b;
    EXPECT_EQ((result == expected), true);
}

TEST(fr, PlusEquals)
{
    fr a{ 0x5def, 0x00, 0x00, 0x00 };
    fr a_copy = a;
    a += 2;
    fr expected = a_copy + 2;
    EXPECT_EQ((a == expected), true);

    a += 3;
    expected = a_copy + 5;
    EXPECT_EQ((a == expected), true);
}

TEST(fr, PrefixIncrement)
{
    fr a{ 0x5def, 0x00, 0x00, 0x00 };
    fr b = ++a;
    EXPECT_EQ(b, a);
}

TEST(fr, PostfixIncrement)
{
    fr a{ 0x5def, 0x00, 0x00, 0x00 };
    fr a_old = a;
    fr b = a++;
    EXPECT_EQ(b, a_old);
    EXPECT_EQ(a, a_old + 1);
}

TEST(fr, ToMontgomeryForm)
{
    fr result{ 0x01, 0x00, 0x00, 0x00 };
    fr expected = fr::one();
    result.self_to_montgomery_form();
    EXPECT_EQ((result == expected), true);
}

TEST(fr, FromMontgomeryForm)
{
    fr result = fr::one();
    fr expected{ 0x01, 0x00, 0x00, 0x00 };
    result.self_from_montgomery_form();
    EXPECT_EQ((result == expected), true);
}

TEST(fr, MontgomeryConsistencyCheck)
{
    fr a = fr::random_element();
    fr b = fr::random_element();
    fr aR;
    fr bR;
    fr aRR;
    fr bRR;
    fr bRRR;
    fr result_a;
    fr result_b;
    fr result_c;
    fr result_d;
    aR = a.to_montgomery_form();
    aRR = aR.to_montgomery_form();
    bR = b.to_montgomery_form();
    bRR = bR.to_montgomery_form();
    bRRR = bRR.to_montgomery_form();
    result_a = aRR * bRR; // abRRR
    result_b = aR * bRRR; // abRRR
    result_c = aR * bR;   // abR
    result_d = a * b;     // abR^-1
    EXPECT_EQ((result_a == result_b), true);
    result_a.self_from_montgomery_form(); // abRR
    result_a.self_from_montgomery_form(); // abR
    result_a.self_from_montgomery_form(); // ab
    result_c.self_from_montgomery_form(); // ab
    result_d.self_to_montgomery_form();   // ab
    EXPECT_EQ((result_a == result_c), true);
    EXPECT_EQ((result_a == result_d), true);
}

TEST(fr, AddMulConsistency)
{
    fr multiplicand = { 0x09, 0, 0, 0 };
    multiplicand.self_to_montgomery_form();

    fr a = fr::random_element();
    fr result;
    result = a + a;   // 2
    result += result; // 4
    result += result; // 8
    result += a;      // 9

    fr expected;
    expected = a * multiplicand;

    EXPECT_EQ((result == expected), true);
}

TEST(fr, SubMulConsistency)
{
    fr multiplicand = { 0x05, 0, 0, 0 };
    multiplicand.self_to_montgomery_form();

    fr a = fr::random_element();
    fr result;
    result = a + a;   // 2
    result += result; // 4
    result += result; // 8
    result -= a;      // 7
    result -= a;      // 6
    result -= a;      // 5

    fr expected;
    expected = a * multiplicand;

    EXPECT_EQ((result == expected), true);
}

TEST(fr, Lambda)
{
    fr x = fr::random_element();

    fr lambda_x = { x.data[0], x.data[1], x.data[2], x.data[3] };
    fr lambda = fr::cube_root_of_unity();
    lambda_x = lambda_x * lambda;

    // compute x^3
    fr x_cubed;
    x_cubed = x * x;
    x_cubed *= x;

    // compute lambda_x^3
    fr lambda_x_cubed;
    lambda_x_cubed = lambda_x * lambda_x;
    lambda_x_cubed *= lambda_x;

    EXPECT_EQ((x_cubed == lambda_x_cubed), true);
}

TEST(fr, Invert)
{
    fr input = fr::random_element();
    fr inverse = input.invert();
    fr result = input * inverse;

    EXPECT_EQ((result == fr::one()), true);
}

TEST(fr, InvertOneIsOne)
{
    fr result = fr::one();
    result = result.invert();
    EXPECT_EQ((result == fr::one()), true);
}

TEST(fr, Sqrt)
{
    fr input = fr::one();
    auto [is_sqr, root] = input.sqrt();
    fr result = root.sqr();
    EXPECT_EQ(result, input);
}

TEST(fr, SqrtRandom)
{
    size_t n = 1;
    for (size_t i = 0; i < n; ++i) {
        fr input = fr::random_element().sqr();
        auto [is_sqr, root] = input.sqrt();
        fr root_test = root.sqr();
        EXPECT_EQ(root_test, input);
    }
}

TEST(fr, OneAndZero)
{
    fr result;
    result = fr::one() - fr::one();
    EXPECT_EQ((result == fr::zero()), true);
}

TEST(fr, Copy)
{
    fr result = fr::random_element();
    fr expected;
    fr::__copy(result, expected);
    EXPECT_EQ((result == expected), true);
}

TEST(fr, Neg)
{
    fr a = fr::random_element();
    fr b;
    b = -a;
    fr result;
    result = a + b;
    EXPECT_EQ((result == fr::zero()), true);
}

TEST(fr, SplitIntoEndomorphismScalars)
{
    fr k = fr::random_element();
    fr k1 = { 0, 0, 0, 0 };
    fr k2 = { 0, 0, 0, 0 };

    fr::split_into_endomorphism_scalars(k, k1, k2);

    fr result{ 0, 0, 0, 0 };

    k1.self_to_montgomery_form();
    k2.self_to_montgomery_form();

    fr lambda = fr::cube_root_of_unity();
    result = k2 * lambda;
    result = k1 - result;

    result.self_from_montgomery_form();
    EXPECT_EQ(result, k);
}

TEST(fr, SplitIntoEndomorphismScalarsSimple)
{

    fr input = { 1, 0, 0, 0 };
    fr k = { 0, 0, 0, 0 };
    fr k1 = { 0, 0, 0, 0 };
    fr k2 = { 0, 0, 0, 0 };
    fr::__copy(input, k);

    fr::split_into_endomorphism_scalars(k, k1, k2);

    fr result{ 0, 0, 0, 0 };
    k1.self_to_montgomery_form();
    k2.self_to_montgomery_form();

    fr lambda = fr::cube_root_of_unity();
    result = k2 * lambda;
    result = k1 - result;

    result.self_from_montgomery_form();
    for (size_t i = 0; i < 4; ++i) {
        EXPECT_EQ(result.data[i], k.data[i]);
    }
}

TEST(fr, BatchInvert)
{
    size_t n = 10;
    std::vector<fr> coeffs(n);
    std::vector<fr> inverses(n);
    fr one = fr::one();
    for (size_t i = 0; i < n; ++i) {
        coeffs[i] = fr::random_element();
        fr::__copy(coeffs[i], inverses[i]);
    }
    fr::batch_invert(&inverses[0], n);

    for (size_t i = 0; i < n; ++i) {
        coeffs[i] *= inverses[i];
        coeffs[i] -= one;
    }

    for (size_t i = 0; i < n; ++i) {
        EXPECT_TRUE(coeffs[i].is_zero());
    }
}

TEST(fr, MultiplicativeGenerator)
{
    EXPECT_EQ(fr::multiplicative_generator(), fr(5));
}

TEST(fr, Uint256Conversions)
{
    constexpr uint256_t a{ 0x1111, 0x2222, 0x3333, 0x4444 };

    constexpr fr b(a);
    constexpr uint256_t c = b;

    static_assert(a == c);
    EXPECT_EQ(a, c);
}
// This test shows that ((lo|hi)% modulus) in uint512_t is equivalent to (lo + 2^256 * hi) in field elements so we
// don't have to use the slow API (uint512_t's modulo operation)
TEST(fr, EquivalentRandomness)
{
    auto& engine = numeric::get_debug_randomness();
    uint512_t random_uint512 = engine.get_random_uint512();
    auto random_lo = fr(random_uint512.lo);
    auto random_hi = fr(random_uint512.hi);
    uint512_t r(fr::modulus);
    constexpr auto pow_2_256 = fr(uint256_t(1) << 128).sqr();
    EXPECT_EQ(random_lo + pow_2_256 * random_hi, fr((random_uint512 % r).lo));
}